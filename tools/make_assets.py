"""Generate SiteAR PNG app icons and a sample IFC4 building (pure Python stdlib).

Run from the sitear folder:   python tools/make_assets.py
"""
import math
import os
import random
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ----------------------------------------------------------------- PNG icon
def write_png(path, w, h, pixel):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw.extend(pixel(x, y))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def icon(size):
    s = size / 512.0
    hexpts = [(256, 104), (388, 180), (388, 332), (256, 408), (124, 332), (124, 180)]
    segs = [(hexpts[i], hexpts[(i + 1) % 6]) for i in range(6)]
    segs += [((124, 180), (256, 256)), ((256, 256), (388, 180)), ((256, 256), (256, 408))]

    def px(x, y):
        X, Y = x / s, y / s
        # rounded-square background, radial gradient
        r = 112
        cx = min(max(X, r), 512 - r); cy = min(max(Y, r), 512 - r)
        if math.hypot(X - cx, Y - cy) > r:
            return (0, 0, 0, 0)
        t = min(1, math.hypot(X - 256, Y - 150) / 420)
        col = [int(26 + (10 - 26) * t), int(34 + (12 - 34) * t), int(50 + (16 - 50) * t)]
        d = min(seg_dist(X, Y, a[0], a[1], b[0], b[1]) for a, b in segs)
        if d < 11:
            k = (X + Y) / 1024  # gradient cyan -> violet
            col = [int(56 + (124 - 56) * k), int(225 + (92 - 225) * k), 255]
        dc = math.hypot(X - 256, Y - 256)
        if dc < 26:
            col = [56, 225, 255]
        return (col[0], col[1], col[2], 255)
    return px


# ----------------------------------------------------------------- IFC sample
CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'


def guid():
    return random.choice('0123') + ''.join(random.choice(CHARS) for _ in range(21))


def make_ifc(path):
    random.seed(7)
    L = []
    n = [0]

    def add(s):
        n[0] += 1
        L.append(f'#{n[0]}={s};')
        return f'#{n[0]}'

    def f(v):
        return f'{float(v):.4f}'.rstrip('0').rstrip('.') + '.' if float(v).is_integer() else f'{float(v):.4f}'

    origin = add('IFCCARTESIANPOINT((0.,0.,0.))')
    zdir = add('IFCDIRECTION((0.,0.,1.))')
    xdir = add('IFCDIRECTION((1.,0.,0.))')
    wcs = add(f'IFCAXIS2PLACEMENT3D({origin},{zdir},{xdir})')
    north = add('IFCDIRECTION((0.2588190451,0.9659258263))')  # project north rotated 15 deg from true north
    ctx = add(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,{wcs},{north})")
    body = add(f"IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,{ctx},$,.MODEL_VIEW.,$)")
    u1 = add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')
    u2 = add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)')
    u3 = add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)')
    u4 = add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')
    units = add(f'IFCUNITASSIGNMENT(({u1},{u2},{u3},{u4}))')
    proj = add(f"IFCPROJECT('{guid()}',$,'SiteAR Sample Building',$,$,$,$,({ctx}),{units})")
    site_pl = add(f'IFCLOCALPLACEMENT($,{wcs})')
    site = add(f"IFCSITE('{guid()}',$,'Site',$,$,{site_pl},$,$,.ELEMENT.,(13,44,10,0),(100,31,30,0),0.,$,$)")
    bld_pl = add(f'IFCLOCALPLACEMENT({site_pl},{wcs})')
    bld = add(f"IFCBUILDING('{guid()}',$,'Building A',$,$,{bld_pl},$,$,.ELEMENT.,$,$,$)")
    add(f"IFCRELAGGREGATES('{guid()}',$,$,$,{proj},({site}))")
    add(f"IFCRELAGGREGATES('{guid()}',$,$,$,{site},({bld}))")

    styles = {}

    def style(name, r, g, b, transp=0.0):
        if name in styles:
            return styles[name]
        c = add(f"IFCCOLOURRGB($,{r},{g},{b})")
        sh = add(f'IFCSURFACESTYLESHADING({c},{transp})')
        st = add(f"IFCSURFACESTYLE('{name}',.BOTH.,({sh}))")
        styles[name] = st
        return st

    def box(storey_pl, x, y, z, lx, ly, h, sty, angle=0.0):
        p = add(f'IFCCARTESIANPOINT(({f(x)},{f(y)},{f(z)}))')
        rd = add(f'IFCDIRECTION(({math.cos(angle):.6f},{math.sin(angle):.6f},0.))')
        a3 = add(f'IFCAXIS2PLACEMENT3D({p},{zdir},{rd})')
        lp = add(f'IFCLOCALPLACEMENT({storey_pl},{a3})')
        p2 = add('IFCCARTESIANPOINT((0.,0.))')
        a2 = add(f'IFCAXIS2PLACEMENT2D({p2},$)')
        prof = add(f'IFCRECTANGLEPROFILEDEF(.AREA.,$,{a2},{f(lx)},{f(ly)})')
        solid = add(f'IFCEXTRUDEDAREASOLID({prof},{wcs},{zdir},{f(h)})')
        add(f'IFCSTYLEDITEM({solid},({sty}),$)')
        rep = add(f"IFCSHAPEREPRESENTATION({body},'Body','SweptSolid',({solid}))")
        pds = add(f'IFCPRODUCTDEFINITIONSHAPE($,$,({rep}))')
        return lp, pds

    wall_s = style('Concrete wall', 0.86, 0.87, 0.88)
    slab_s = style('Slab', 0.62, 0.65, 0.70)
    col_s = style('Column', 0.48, 0.55, 0.66)
    glass_s = style('Glass', 0.55, 0.80, 0.95, 0.6)
    proxy_s = style('Equipment', 0.95, 0.62, 0.25)

    W, D, H = 24.0, 14.0, 3.5
    storeys = []
    for lvl in range(2):
        elev = lvl * H
        pl_pt = add(f'IFCCARTESIANPOINT((0.,0.,{f(elev)}))')
        pl_ax = add(f'IFCAXIS2PLACEMENT3D({pl_pt},$,$)')
        st_pl = add(f'IFCLOCALPLACEMENT({bld_pl},{pl_ax})')
        st = add(f"IFCBUILDINGSTOREY('{guid()}',$,'Level {lvl + 1}',$,$,{st_pl},$,$,.ELEMENT.,{f(elev)})")
        storeys.append(st)
        elems = []
        t = 0.25
        # slab
        lp, pds = box(st_pl, W / 2, D / 2, -0.2, W, D, 0.2, slab_s)
        elems.append(add(f"IFCSLAB('{guid()}',$,'Floor slab L{lvl + 1}',$,$,{lp},{pds},'SL-{lvl + 1}',.FLOOR.)"))
        # outer walls (with window strips on the long sides)
        walls = [(W / 2, t / 2, W, t, 'South'), (W / 2, D - t / 2, W, t, 'North'), (t / 2, D / 2, t, D - 2 * t, 'West'), (W - t / 2, D / 2, t, D - 2 * t, 'East')]
        for i, (x, y, lx, ly, nm) in enumerate(walls):
            hh = 1.0 if nm in ('South', 'North') else H - 0.2
            lp, pds = box(st_pl, x, y, 0, lx, ly, hh, wall_s)
            elems.append(add(f"IFCWALL('{guid()}',$,'Wall {nm} L{lvl + 1}',$,'Basic Wall:Exterior 250',{lp},{pds},'W{lvl + 1}{i}',.STANDARD.)"))
            if nm in ('South', 'North'):
                lp, pds = box(st_pl, x, y, 1.0, lx, 0.06, 1.8, glass_s)
                elems.append(add(f"IFCPLATE('{guid()}',$,'Curtain glazing {nm} L{lvl + 1}',$,$,{lp},{pds},$,.CURTAIN_PANEL.)"))
                lp, pds = box(st_pl, x, y, 2.8, lx, ly, H - 0.2 - 2.8, wall_s)
                elems.append(add(f"IFCWALL('{guid()}',$,'Spandrel {nm} L{lvl + 1}',$,$,{lp},{pds},$,.STANDARD.)"))
        # interior walls
        lp, pds = box(st_pl, 9.0, 5.0, 0, 0.15, 10.0 - 2 * t, H - 0.2, wall_s)
        elems.append(add(f"IFCWALL('{guid()}',$,'Partition A L{lvl + 1}',$,'Basic Wall:Interior 150',{lp},{pds},$,.PARTITIONING.)"))
        lp, pds = box(st_pl, 16.5, 9.0, 0, 15.0, 0.15, H - 0.2, wall_s)
        elems.append(add(f"IFCWALL('{guid()}',$,'Partition B L{lvl + 1}',$,'Basic Wall:Interior 150',{lp},{pds},$,.PARTITIONING.)"))
        # columns on a 6 m grid
        for gx in range(0, 5):
            for gy in range(0, 3):
                cx, cy = 0.6 + gx * (W - 1.2) / 4, 0.6 + gy * (D - 1.2) / 2
                lp, pds = box(st_pl, cx, cy, 0, 0.4, 0.4, H - 0.2, col_s)
                elems.append(add(f"IFCCOLUMN('{guid()}',$,'Column {chr(65 + gy)}{gx + 1} L{lvl + 1}',$,'Concrete-Rectangular 400x400',{lp},{pds},'C{chr(65 + gy)}{gx + 1}',.COLUMN.)"))
        # equipment
        if lvl == 0:
            lp, pds = box(st_pl, 20.5, 3.0, 0, 2.0, 1.2, 1.8, proxy_s)
            elems.append(add(f"IFCBUILDINGELEMENTPROXY('{guid()}',$,'AHU-01',$,'Air handling unit',{lp},{pds},'AHU-01',.ELEMENT.)"))
        add(f"IFCRELCONTAINEDINSPATIALSTRUCTURE('{guid()}',$,$,$,({','.join(elems)}),{st})")
    # roof slab
    pl_pt = add(f'IFCCARTESIANPOINT((0.,0.,{f(2 * H)}))')
    pl_ax = add(f'IFCAXIS2PLACEMENT3D({pl_pt},$,$)')
    rf_pl = add(f'IFCLOCALPLACEMENT({bld_pl},{pl_ax})')
    rf = add(f"IFCBUILDINGSTOREY('{guid()}',$,'Roof',$,$,{rf_pl},$,$,.ELEMENT.,{f(2 * H)})")
    storeys.append(rf)
    lp, pds = box(rf_pl, W / 2, D / 2, -0.2, W, D, 0.25, slab_s)
    roof = add(f"IFCSLAB('{guid()}',$,'Roof slab',$,$,{lp},{pds},'RF',.ROOF.)")
    add(f"IFCRELCONTAINEDINSPATIALSTRUCTURE('{guid()}',$,$,$,({roof}),{rf})")
    add(f"IFCRELAGGREGATES('{guid()}',$,$,$,{bld},({','.join(storeys)}))")

    head = ("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');\n"
            "FILE_NAME('sample-building.ifc','2026-11-20T09:00:00',('SiteAR'),('SiteAR'),'SiteAR generator','SiteAR','');\n"
            "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n")
    with open(path, 'w', encoding='ascii', newline='\n') as fh:
        fh.write(head + '\n'.join(L) + '\nENDSEC;\nEND-ISO-10303-21;\n')


if __name__ == '__main__':
    for sz in (192, 512):
        write_png(os.path.join(ROOT, 'icons', f'icon-{sz}.png'), sz, sz, icon(sz))
    make_ifc(os.path.join(ROOT, 'samples', 'sample-building.ifc'))
    print('icons + sample IFC written')
