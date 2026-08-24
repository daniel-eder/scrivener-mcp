/**
 * Scrivener XML serialization model builder.
 *
 * The project loader parses .scrivx files with xml2js using `mergeAttrs: true`,
 * which flattens XML attributes into regular object properties. That model is
 * convenient for internal manipulation, but serializing it directly produces
 * invalid .scrivx markup (attributes become child elements, e.g.
 * `<BinderItem><UUID>...</UUID></BinderItem>` instead of
 * `<BinderItem UUID="...">`), which Scrivener rejects as corruption.
 *
 * This module converts the flattened model back into the attribute-aware shape
 * xml2js Builder expects (`$` for attributes, `_` for text content) using a
 * policy table derived from real Scrivener-generated project files. It also
 * normalizes ISO timestamps to Scrivener's native date format.
 */

type XmlNode = Record<string, unknown>;

/** Tags whose known properties must be serialized as XML attributes. */
const ATTR_POLICIES: Record<string, readonly string[] | 'all'> = {
	ScrivenerProject: [
		'Template',
		'Version',
		'Identifier',
		'Creator',
		'Device',
		'Modified',
		'ModID',
		'Build',
	],
	BinderItem: ['UUID', 'Type', 'Created', 'Modified'],
	Collection: ['Type', 'ID', 'Color'],
	Bookmark: ['BinderUUID', 'BookmarkFile'],
	Label: ['ID', 'Color'],
	Status: ['ID'],
	Type: ['ID'],
	ProjectTargets: ['Notify'],
	RecentWritingHistory: ['Date'],

	// Attribute-only leaf elements (no child elements in Scrivener output).
	SearchSettings: 'all',
	DraftTarget: 'all',
	SessionTarget: 'all',
	PreviousSession: 'all',
	PrintSettings: 'all',
	TextSelection: 'all',
};

const CHARKEY = '_';
const ATTRKEY = '$';

const DATE_KEYS = new Set(['Created', 'Modified', 'Date', 'Deadline']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function isPlainObject(value: unknown): value is XmlNode {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Format a Date in Scrivener's native format: "YYYY-MM-DD HH:MM:SS +ZZZZ"
 * (local time with numeric UTC offset).
 */
export function toScrivenerDateString(date: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? '+' : '-';
	const abs = Math.abs(offsetMinutes);
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		` ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
	);
}

function isoToScrivenerDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return toScrivenerDateString(date);
}

/**
 * Convert the flattened (mergeAttrs) project model into xml2js Builder shape.
 * Returns a normalized deep copy of the input tree.
 */
export function toScrivenerXmlModel<T>(input: T): T {
	return transformValue(input, undefined) as T;
}

function transformValue(value: unknown, tagName: string | undefined): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => transformValue(item, tagName));
	}
	if (!isPlainObject(value)) {
		return value;
	}

	const node: XmlNode = {};
	for (const [key, child] of Object.entries(value)) {
		node[key] = transformValue(child, key);
	}

	// Normalize ISO timestamps to Scrivener's native date format.
	for (const [key, val] of Object.entries(node)) {
		if (typeof val === 'string' && DATE_KEYS.has(key) && ISO_DATE_RE.test(val)) {
			node[key] = isoToScrivenerDate(val);
		}
	}

	// Drop empty containers so we don't emit `<Children/>`-style artifacts,
	// which differ from Scrivener's own output for childless items.
	for (const [key, val] of Object.entries(node)) {
		if (isPlainObject(val) && Object.keys(val).length === 0) {
			delete node[key];
		} else if (Array.isArray(val) && val.length === 0) {
			delete node[key];
		}
	}

	if (tagName) {
		applyAttributePolicy(node, tagName);
	}
	return node;
}

/**
 * Apply the attribute policy to a single named node. Called by the walker for
 * every object that has a tag name in the document tree.
 */
function applyAttributePolicy(node: XmlNode, tagName: string): void {
	const policy = ATTR_POLICIES[tagName];
	if (!policy) {
		return;
	}

	const candidates =
		policy === 'all'
			? Object.keys(node)
			: policy.filter((key) => Object.prototype.hasOwnProperty.call(node, key));

	const attrs: Record<string, unknown> = {};
	for (const key of candidates) {
		if (key === CHARKEY || key === ATTRKEY) {
			continue;
		}
		const value = node[key];
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			attrs[key] = value;
			delete node[key];
		}
	}

	if (Object.keys(attrs).length > 0) {
		const existing = isPlainObject(node[ATTRKEY]) ? (node[ATTRKEY] as XmlNode) : {};
		node[ATTRKEY] = { ...existing, ...attrs };
	}
}
