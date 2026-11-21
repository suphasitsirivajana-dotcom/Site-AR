// Project data model. Schema documented in /schema/sitear-project.schema.json
// (shared contract with the future Unity app). All positions are IFC coordinates in metres, Z-up.
export const SCHEMA = 'sitear.project/1.0';

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

export const MARKUP_TYPES = {
  capture: { label: 'Capture', color: '#93c5fd', icon: 'photo' },
  comment: { label: 'Comment', color: '#3b82f6', icon: 'comment' },
  note: { label: 'Note', color: '#9cc2f5', icon: 'note' },
  issue: { label: 'Issue', color: '#2b5fd9', icon: 'issue' }
};
export const STATUSES = {
  open: { label: 'Open', bcf: 'Open' },
  'in-progress': { label: 'In progress', bcf: 'In Progress' },
  resolved: { label: 'Resolved', bcf: 'Resolved' },
  closed: { label: 'Closed', bcf: 'Closed' }
};
export const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High' };

export function statusColor(m) {
  if (m.status === 'resolved') return '#7aa7e8';
  if (m.status === 'closed') return '#6b7686';
  return (MARKUP_TYPES[m.type] || MARKUP_TYPES.comment).color;
}

export function newProject(name = 'Untitled project') {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA,
    id: uuid(),
    name,
    createdAt: now,
    modifiedAt: now,
    units: 'm',
    coordinateSystem: { up: 'Z', handedness: 'right', note: 'All positions are IFC/project coordinates in metres' },
    models: [],
    geo: { anchor: null, controlPoints: [] },
    markups: [],
    groups: [],
    views: [],
    tracks: [],
    nextNumber: 1,
    app: { viewOrigin: null }
  };
}

export function newMarkup(p, fields) {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    number: p.nextNumber++,
    type: 'comment',
    title: '',
    text: '',
    status: 'open',
    priority: 'normal',
    assignedTo: '',
    group: null,
    author: '',
    createdAt: now,
    modifiedAt: now,
    position: { x: 0, y: 0, z: 0 },
    element: null,
    gps: null,
    source: '3d',
    viewpoint: null,
    snapshot: null,
    photos: [],
    replies: [],
    locked: false,
    ...fields
  };
}

export function markupTitle(m) {
  if (m.title) return m.title;
  const t = (m.text || '').split('\n')[0].trim();
  return t ? t.slice(0, 60) : `${(MARKUP_TYPES[m.type] || MARKUP_TYPES.comment).label} #${m.number}`;
}

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
