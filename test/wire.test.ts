import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENT,
  decodeDeltaPath,
  decodeDocument,
  decodePathAuto,
  decodePolygon,
  encodeDeltaPath,
  encodeDocument,
  encodePathSmart,
  encodePolygon,
  ScrError,
  type ScrDocument,
} from '../src/index.js';
import type { GridLine, GridPolygon } from '../src/wire/types.js';

function baseDoc(): ScrDocument {
  return {
    version: 1,
    envelope: { type: 'tile', z: 15, x: 5240, y: 12661 },
    projection: 'webmerc',
    extent: DEFAULT_EXTENT,
    buffer: 64,
    meta: {},
    layers: new Map(),
    classes: new Map(),
    strings: new Map(),
    attrSets: new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: [],
  };
}

describe('delta geometry', () => {
  it('encodes and decodes a path with no loss', () => {
    const line: GridLine = [
      { x: 0, y: 2048 },
      { x: 1024, y: 2048 },
      { x: 2048, y: 2100 },
      { x: 4096, y: 2048 },
    ];
    const text = encodeDeltaPath(line);
    expect(text.startsWith('d:')).toBe(true);
    expect(decodeDeltaPath(text)).toEqual(line);
  });

  it('handles negative deltas', () => {
    const line: GridLine = [
      { x: 100, y: 100 },
      { x: 50, y: 40 },
      { x: -20, y: -5 },
    ];
    expect(decodeDeltaPath(encodeDeltaPath(line))).toEqual(line);
  });

  it('handles a single vertex', () => {
    const line: GridLine = [{ x: 7, y: 9 }];
    expect(decodeDeltaPath(encodeDeltaPath(line))).toEqual(line);
  });

  it('rejects an odd vertex count rather than guessing', () => {
    expect(() => decodeDeltaPath('d:1,2,3')).toThrow(ScrError);
  });

  it('treats a bare prefix as an empty path, matching the encoder', () => {
    // `encodeDeltaPath([])` returns '', so decoding `d:` must return [] for the
    // round trip to hold rather than throwing.
    expect(decodeDeltaPath('d:')).toEqual([]);
    expect(encodeDeltaPath([])).toBe('');
  });

  it('accepts absolute input through the auto-detecting parser', () => {
    expect(decodePathAuto('10,20;30,40')).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it('uses delta for long paths and absolute for short ones', () => {
    const short: GridLine = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const long: GridLine = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
      { x: 7, y: 8 },
    ];
    expect(encodePathSmart(short).startsWith('d:')).toBe(false);
    expect(encodePathSmart(long).startsWith('d:')).toBe(true);
  });
});

describe('polygon rings', () => {
  it('round-trips a polygon with a hole', () => {
    const poly: GridPolygon = [
      {
        rings: [
          [
            { x: 0, y: 0 },
            { x: 400, y: 0 },
            { x: 400, y: 400 },
            { x: 0, y: 400 },
          ],
          [
            { x: 100, y: 100 },
            { x: 200, y: 100 },
            { x: 200, y: 200 },
            { x: 100, y: 200 },
          ],
        ],
      },
    ];
    const text = encodePolygon(poly);
    expect(text).toContain('|');
    expect(decodePolygon(text)).toEqual(poly);
  });

  it('keeps multipart polygons unambiguous via the part separator', () => {
    const poly: GridPolygon = [
      { rings: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]] },
      { rings: [[{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }]] },
    ];
    const decoded = decodePolygon(encodePolygon(poly));
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.rings).toHaveLength(1);
    expect(decoded[1]!.rings).toHaveLength(1);
  });
});

describe('document round trip', () => {
  it('preserves every record type', () => {
    const doc = baseDoc();
    doc.meta.source = 'osm';
    doc.meta.date = '2026-09-17';
    doc.layers.set(1, { id: 1, name: 'road' });
    doc.layers.set(2, { id: 2, name: 'poi' });
    doc.classes.set(1, { id: 1, layerId: 1, name: 'road.primary' });
    doc.classes.set(2, { id: 2, layerId: 2, name: 'amenity.cafe' });
    doc.strings.set(10, 'name');
    doc.strings.set(100, 'Blue Bottle Coffee');
    doc.attrSets.set(1, { id: 1, props: [{ key: 10, value: { t: 'ref', ref: 100 } }] });
    doc.features.push({
      id: 1,
      layerId: 1,
      classId: 1,
      kind: 'line',
      attrSet: 0,
      geometry: {
        kind: 'line',
        lines: [
          [
            { x: 0, y: 2048 },
            { x: 1024, y: 2048 },
            { x: 4096, y: 2048 },
          ],
        ],
      },
    });
    doc.features.push({
      id: 2,
      layerId: 2,
      classId: 2,
      kind: 'point',
      attrSet: 1,
      geometry: { kind: 'point', point: { x: 2100, y: 2150 } },
    });
    doc.heat.push({
      id: 1,
      name: 'crowd',
      resolution: 64,
      minValue: 0,
      maxValue: 255,
      encoding: 'sparse',
      cells: [{ x: 32, y: 18, value: 92 }],
    });
    doc.omissions.push({ layerId: 1, count: 137, centroid: { x: 2048, y: 2048 } });
    doc.refs.push({ kind: 'buildings', uri: 'scr://tile/15/5240/12661/b.bin', mime: 'application/octet-stream' });
    doc.routes.push({
      id: 1,
      mode: 'walk',
      dist: 840,
      time: 610,
      steps: [
        { n: 1, instruction: 'head east on Mission Street', dist: 120, ref: 101, turn: 'left' },
        { n: 2, instruction: 'turn left on 5th Street', dist: 90 },
      ],
    });
    doc.strings.set(101, 'Mission Street');

    const decoded = decodeDocument(encodeDocument(doc));

    expect(decoded.version).toBe(1);
    expect(decoded.envelope).toEqual(doc.envelope);
    expect(decoded.extent).toBe(doc.extent);
    expect(decoded.buffer).toBe(doc.buffer);
    expect(decoded.meta).toEqual(doc.meta);
    expect(decoded.layers.get(1)!.name).toBe('road');
    expect(decoded.classes.get(2)!.name).toBe('amenity.cafe');
    expect(decoded.strings.get(100)).toBe('Blue Bottle Coffee');
    expect(decoded.features).toEqual(doc.features);
    expect(decoded.heat[0]!.cells).toEqual([{ x: 32, y: 18, value: 92 }]);
    expect(decoded.omissions[0]!.count).toBe(137);
    expect(decoded.refs[0]!.uri).toBe('scr://tile/15/5240/12661/b.bin');
    expect(decoded.routes[0]!.steps[0]!.instruction).toBe('head east on Mission Street');
    expect(decoded.routes[0]!.steps[0]!.turn).toBe('left');
    expect(decoded.routes[0]!.steps[0]!.ref).toBe(101);
  });

  it('preserves a building polygon exactly', () => {
    const doc = baseDoc();
    doc.layers.set(1, { id: 1, name: 'building' });
    doc.classes.set(1, { id: 1, layerId: 1, name: 'building.commercial' });
    doc.features.push({
      id: 1,
      layerId: 1,
      classId: 1,
      kind: 'building',
      attrSet: 0,
      geometry: {
        kind: 'building',
        polygon: [
          {
            rings: [
              [
                { x: 100, y: 100 },
                { x: 300, y: 100 },
                { x: 300, y: 300 },
                { x: 100, y: 300 },
              ],
            ],
          },
        ],
      },
    });
    const decoded = decodeDocument(encodeDocument(doc));
    expect(decoded.features[0]!.geometry).toEqual(doc.features[0]!.geometry);
  });

  it('is idempotent: encoding a decoded document reproduces the text', () => {
    const doc = baseDoc();
    doc.layers.set(1, { id: 1, name: 'road' });
    doc.classes.set(1, { id: 1, layerId: 1, name: 'road.primary' });
    doc.features.push({
      id: 1,
      layerId: 1,
      classId: 1,
      kind: 'line',
      attrSet: 0,
      geometry: { kind: 'line', lines: [[{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }]] },
    });
    const once = encodeDocument(doc, { group: false });
    const twice = encodeDocument(decodeDocument(once), { group: false });
    expect(twice).toBe(once);
  });
});

describe('attribute values', () => {
  it('distinguishes string references from bare tokens', () => {
    const doc = baseDoc();
    doc.attrSets.set(1, {
      id: 1,
      props: [
        { key: 10, value: { t: 'ref', ref: 100 } },
        { key: 11, value: { t: 'num', num: 18 } },
        { key: 12, value: { t: 'bool', bool: true } },
        { key: 13, value: { t: 'token', token: 'sidewalk' } },
      ],
    });
    doc.strings.set(10, 'name');
    doc.strings.set(100, 'x');
    const decoded = decodeDocument(encodeDocument(doc));
    expect(decoded.attrSets.get(1)!.props).toEqual(doc.attrSets.get(1)!.props);
  });

  it('treats a numeric string as a number, not a string reference', () => {
    const doc = baseDoc();
    doc.strings.set(10, 'height');
    doc.attrSets.set(1, { id: 1, props: [{ key: 10, value: { t: 'num', num: 18 } }] });
    const decoded = decodeDocument(encodeDocument(doc));
    expect(decoded.attrSets.get(1)!.props[0]!.value.t).toBe('num');
  });
});

describe('heat layers', () => {
  it('round-trips run-length rows', () => {
    const doc = baseDoc();
    doc.heat.push({
      id: 1,
      name: 'flood',
      resolution: 64,
      minValue: 0,
      maxValue: 255,
      encoding: 'rle',
      rows: [{ y: 12, runs: [{ x: 10, len: 5, value: 200 }, { x: 30, len: 2, value: 80 }] }],
    });
    const decoded = decodeDocument(encodeDocument(doc));
    expect(decoded.heat[0]!.encoding).toBe('rle');
    expect(decoded.heat[0]!.rows).toEqual([{ y: 12, runs: [{ x: 10, len: 5, value: 200 }, { x: 30, len: 2, value: 80 }] }]);
  });

  it('round-trips externally indexed cells', () => {
    const doc = baseDoc();
    doc.heat.push({
      id: 2,
      name: 'delay',
      resolution: 0,
      minValue: 0,
      maxValue: 100,
      encoding: 'cell',
      indexed: [{ cell: '8a28308280fffff', value: 72 }],
    });
    const decoded = decodeDocument(encodeDocument(doc));
    expect(decoded.heat[0]!.indexed).toEqual([{ cell: '8a28308280fffff', value: 72 }]);
  });

  it('rejects a heat record that references an undeclared layer', () => {
    const doc = baseDoc();
    const text = encodeDocument(doc) + 'X 9 1,2,3\n';
    expect(() => decodeDocument(text)).toThrow(/undeclared/);
  });
});

describe('malformed input', () => {
  it('rejects a missing header', () => {
    expect(() => decodeDocument('TILE 1 1 1\nQ 4096\n')).toThrow(/header/);
  });

  it('rejects an unknown major version', () => {
    expect(() => decodeDocument('SCR 99\nTILE 1 1 1\nQ 4096\n')).toThrow(/version/);
  });

  it('rejects a missing envelope', () => {
    expect(() => decodeDocument('SCR 1\nQ 4096\n')).toThrow(/envelope/);
  });

  it('rejects a missing Q record', () => {
    expect(() => decodeDocument('SCR 1\nTILE 1 1 1\n')).toThrow(/quantization/);
  });

  it('rejects an unknown record tag', () => {
    expect(() => decodeDocument('SCR 1\nTILE 1 1 1\nQ 4096\nWAT 1\n')).toThrow(/unknown record tag/);
  });

  it('rejects an unknown geometry kind', () => {
    expect(() => decodeDocument('SCR 1\nTILE 1 1 1\nQ 4096\nF 1 1 1 Z 0 1,2\n')).toThrow(/geometry kind/);
  });

  it('rejects a non-integer Q value rather than truncating', () => {
    expect(() => decodeDocument('SCR 1\nTILE 1 1 1\nQ 4096.5\n')).toThrow(/integer/);
  });

  it('reports the line number of a bad record', () => {
    try {
      decodeDocument('SCR 1\nTILE 1 1 1\nQ 4096\nBOGUS\n');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScrError);
      expect((e as ScrError).line).toBe(4);
    }
  });

  it('enforces the feature cap against a hostile document', () => {
    const doc = baseDoc();
    doc.layers.set(1, { id: 1, name: 'road' });
    doc.classes.set(1, { id: 1, layerId: 1, name: 'road.primary' });
    for (let i = 0; i < 50; i++) {
      doc.features.push({
        id: i,
        layerId: 1,
        classId: 1,
        kind: 'line',
        attrSet: 0,
        geometry: { kind: 'line', lines: [[{ x: 0, y: 0 }, { x: 10, y: 10 }]] },
      });
    }
    expect(() => decodeDocument(encodeDocument(doc), { maxFeatures: 10 })).toThrow(/maxFeatures/);
  });

  it('ignores comments and blank lines', () => {
    const text = 'SCR 1\n\n# a comment\nTILE 1 1 1\nQ 4096\n\n# trailing\n';
    const doc = decodeDocument(text);
    expect(doc.extent).toBe(4096);
  });
});
