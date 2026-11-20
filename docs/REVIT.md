# Revit ⇄ SiteAR

## 1. Revit → SiteAR (IFC)

1. **File → Export → IFC**
2. Modify Setup:
   - IFC version: **IFC4 Reference View** (or IFC2x3 Coordination View 2.0)
   - **Coordinate Base: Shared Coordinates**, so coordinates match the surveyor's
   - Property Sets: tick *Export IFC common property sets*
   - Set the Site location (Manage → Location) and True North in Revit, and SiteAR will pick them up automatically
3. Open the .ifc in SiteAR with **Open Model**

> DWG cannot be opened directly (closed format). In AutoCAD use **Save As → DXF**.

## 2. SiteAR → Revit with BCF (recommended, no script needed)

1. SiteAR: **Export → Export BCF** (.bcfzip, BCF 3.0)
2. Revit: install a free BCF add-in, e.g. **BIMcollab Zoom + BCF Manager for Revit** (KUBUS)
3. Import the .bcfzip. Clicking a topic makes Revit jump to the camera and select the element (via IFC GUID)
4. Mark it resolved in Revit → export BCF → SiteAR **Import BCF** (the status updates; it does not duplicate the topic)

## 3. Place markups as real elements in Revit (Dynamo, IronPython 2.7)

This script **modifies the model**: it places one instance of the family you choose at every markup position from the `Project JSON` file.

### How to use
1. Create or load a small **Generic Model** family, e.g. `SiteAR_Pin` (a sphere/cone at the origin) that has the parameters `Comments` and `Mark`
2. Dynamo → **Python Script** node → paste the code below
3. Inputs: `IN[0]` = path to the `.sitear.json` file (File Path node), `IN[1]` = family type name, e.g. `"SiteAR_Pin"`, `IN[2]` = `True` if the IFC was exported with **Shared Coordinates** (default)
4. Run → `OUT` reports how many were placed and which were skipped

```python
# SiteAR markups -> Revit family instances  (Dynamo 2.x, IronPython 2.7)
import clr, json
clr.AddReference('RevitServices')
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager
clr.AddReference('RevitAPI')
from Autodesk.Revit.DB import *
clr.AddReference('RevitAPIUI')
from Autodesk.Revit.UI import *
doc = DocumentManager.Instance.CurrentDBDocument
uidoc = DocumentManager.Instance.CurrentUIApplication.ActiveUIDocument

json_path   = IN[0]                                   # path to *.sitear.json
type_name   = IN[1] if len(IN) > 1 and IN[1] else 'SiteAR_Pin'
use_shared  = IN[2] if len(IN) > 2 and IN[2] is not None else True

M_TO_FT = 1.0 / 0.3048                                # SiteAR stores metres, Revit uses feet internally

# --- read the project file (UTF-8, may contain Thai text)
import io
with io.open(json_path, 'r', encoding='utf-8') as f:
    project = json.loads(f.read())
markups = project.get('markups', [])

# --- find the family type (Generic Model) by type name
symbol = None
for s in FilteredElementCollector(doc).OfClass(FamilySymbol):
    if Element.Name.GetValue(s) == type_name:
        symbol = s
        break

# --- shared -> internal coordinates (IFC exported with Shared Coordinates)
to_internal = doc.ActiveProjectLocation.GetTotalTransform().Inverse if use_shared else Transform.Identity

# --- nearest level below a given internal Z
levels = sorted(FilteredElementCollector(doc).OfClass(Level).ToElements(), key=lambda l: l.Elevation)
def level_for(z):
    best = levels[0] if levels else None
    for l in levels:
        if l.Elevation <= z + 0.01:
            best = l
    return best

placed, skipped = [], []
if symbol is None:
    OUT = 'Family type "%s" not found. Load a Generic Model family with that type name first.' % type_name
elif not markups:
    OUT = 'No markups in %s' % json_path
else:
    TransactionManager.Instance.EnsureInTransaction(doc)
    try:
        if not symbol.IsActive:
            symbol.Activate()
        for m in markups:
            p = m.get('position')
            if not p:
                skipped.append(m.get('number')); continue
            pt = to_internal.OfPoint(XYZ(p['x'] * M_TO_FT, p['y'] * M_TO_FT, p['z'] * M_TO_FT))
            lvl = level_for(pt.Z)
            if lvl is None:
                skipped.append(m.get('number')); continue
            inst = doc.Create.NewFamilyInstance(pt, symbol, lvl, Structure.StructuralType.NonStructural)
            # write markup info into standard parameters
            title = m.get('title') or (m.get('text') or '').split('\n')[0]
            info = u'[%s #%s] %s | %s' % (m.get('type', ''), m.get('number', ''), title, m.get('status', ''))
            c = inst.LookupParameter('Comments')
            if c and not c.IsReadOnly: c.Set(info)
            k = inst.LookupParameter('Mark')
            if k and not k.IsReadOnly: k.Set('SAR-%s' % m.get('number', ''))
            placed.append(inst)
        TransactionManager.Instance.TransactionTaskDone()
        OUT = {'placed': len(placed), 'skipped (no position/level)': skipped, 'elements': placed}
    except Exception as e:
        TransactionManager.Instance.ForceCloseTransaction()
        OUT = 'Error: %s' % e
```

**Customization**
- If the IFC was exported with **Internal Coordinates**, set `IN[2] = False`
- To write more data (e.g. the IFC GUID of the element the markup is attached to), add `LookupParameter('YourParam')` and use `m['element']['guid']`
- Revit 2024+ with CPython 3 (Dynamo 3): the code works as-is (it uses neither f-strings nor DisplayUnitType)
