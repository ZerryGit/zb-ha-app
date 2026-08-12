import { createId } from '../utils/ids.js';

export const typeDisplayNames = {
  rect: 'Rect',
  text: 'Text',
  line: 'Line',
  circle: 'Circle',
  img: 'Image',
  svg: 'SVG',
  graph: 'Graph',
};

function mergeElement(base, partialOverrides) {
  if (!partialOverrides) return base;

  const merged = { ...base, ...partialOverrides };

  if (partialOverrides.pos) merged.pos = { ...base.pos, ...partialOverrides.pos };
  if (partialOverrides.scale) merged.scale = { ...base.scale, ...partialOverrides.scale };
  if (partialOverrides.origin) merged.origin = { ...base.origin, ...partialOverrides.origin };

  return merged;
}

export function createElement(type, partialOverrides) {
  const base = {
    id: createId(),
    type,
    name: partialOverrides?.name || 'Element',
    visible: true,

    pos: { x: 20, y: 20 },
    rotationDeg: 0,
    scale: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
  };

  let typedDefaults = {};

  switch (type) {
    case 'rect':
      typedDefaults = {
        sizeX: 240,
        sizeY: 160,
        enableFill: true,
        fill: 0,
        enableStroke: true,
        strokeDither: 100,
        strokeWidth: 1,
        strokeDash: [],
        strokeCap: 'butt',
        strokePosition: 'center',
      };
      break;

    case 'text':
      typedDefaults = {
        // New text elements are a sized, locked frame: typing wraps at the
        // right edge and the box never grows on its own. The "Text overflow"
        // toggle switches to grow-down ('fixed'); the Sizing control reaches
        // the legacy hugging behaviour ('auto').
        sizeX: 120,
        sizeY: 60,
        text: 'Text',
        fallbackText: '(no data)',
        enableFill: true,
        fill: 100,
        fontFamily: 'Sora',
        fontSize: 20,
        fontWeight: 400,
        textAlign: 'left',
        lineHeight: 1.2,
        textFlow: 'clip',
      };
      break;

    case 'line':
      typedDefaults = {
        pos: { x: 40, y: 60 },
        points: [
          [0, 0],
          [120, 0],
        ],
        enableStroke: true,
        strokeDither: 100,
        strokeWidth: 2,
        strokeDash: [],
        strokeCap: 'butt',
        strokePosition: 'center',
      };
      break;

    case 'circle':
      typedDefaults = {
        sizeX: 80,
        sizeY: 80,
        enableFill: true,
        fill: 0,
        enableStroke: true,
        strokeDither: 100,
        strokeWidth: 1,
        strokeDash: [],
        strokeCap: 'butt',
        strokePosition: 'center',
        innerSize: 0,
        arcStartDeg: 0,
        arcEndDeg: 0,
      };
      break;

    case 'img':
      typedDefaults = {
        sizeX: 96,
        sizeY: 96,
        src: '',
        bwMode: 'threshold',
        bwLevel: 50,
      };
      break;

    case 'svg':
      typedDefaults = {
        sizeX: 160,
        sizeY: 96,
        src: '',
        svg: '',
        bwMode: 'dither',
        bwLevel: 60,
        // enableFill drives the engine's shapeMask rendering path, which only
        // writes dark pixels and leaves white/transparent areas untouched.
        // Without this, the engine writes white pixels that erase underlying content.
        enableFill: true,
        fill: 100,
      };
      break;

    case 'graph':
      typedDefaults = {
        sizeX: 280,
        sizeY: 160,
        // Chart configuration
        chartType: 'line',
        sourceId: '',
        dataPath: 'points',
        valuePath: 'v',
        timePath: 't',
        resolution: 100,
        dataRangeStart: 0,
        dataRangeEnd: 100,
        // Axis & grid
        showAxes: true,
        showGrid: true,
        gridLines: 4,
        showLabels: true,
        labelFontSize: 10,
        labelFontWeight: 400,
        showXEndLabel: false,
        xLabelInterval: 0,
        xLabelRotation: 0,
        showDateLabels: true,
        // Title
        showTitle: false,
        titleText: '',
        titleFontSize: 10,
        titleFontWeight: 600,
        titleDither: 100,
        // Y-axis range (null = auto)
        yMin: null,
        yMax: null,
        // Line chart styling
        lineStrokeWidth: 2,
        lineStrokeDither: 100,
        lineStrokeRadius: 0,
        // Bar chart styling
        barGap: 2,
        barFillDither: 100,
        barStrokeEnabled: false,
        barStrokeDither: 100,
        // Axis styling
        axisDither: 100,
        gridDither: 40,
        gridDash: [2, 3],
        labelDither: 100,
      };
      break;

    default:
      typedDefaults = {};
      break;
  }

  return mergeElement({ ...base, ...typedDefaults }, partialOverrides);
}
