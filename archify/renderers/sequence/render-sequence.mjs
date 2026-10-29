import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, renderSemanticSigil, textUnits } from '../shared/utils.mjs';
import { animateAttr, focusEdgeAttrs, focusNodeAttrs, focusNodeTitle, loadDiagramWithBrandMarks, writeDiagram, svgAccessibleText, svgRootAttrs } from '../shared/cli.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { legendFootprint, measureLegend, resolveLegend, renderLegend as renderResolvedLegend } from '../shared/legend.mjs';
import { componentFill, arrowClassMap, rectsOverlap, cleanFlowProblems, cleanCrossingProblems, cleanAmbiguousCorridorProblems, cleanBorderRunProblems, cleanRouteRhythmProblems, cleanLabelRouteClearanceProblems, cleanLabelCanvasContainmentProblems, routePointsValue, asArray, isFinitePoint, edgeLabelAccent } from '../shared/geometry.mjs';
import { availableNodeTextWidth, fittedNodeFontSize, minimumNodeTextWidth } from '../shared/text-fit.mjs';
import { brandLabelFitWidth, brandMetadataFor, brandTopRailProblem, renderBrandMark } from '../shared/brand-marks.mjs';
import { translateMessage as i18nText } from '../shared/i18n.mjs';
import { DESKTOP_READER_DIAGRAM_WIDTH, MIN_PROJECTED_NODE_TEXT_PX, minimumReadableSourceTextPx } from '../shared/desktop-readability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { diagram: sequence, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks({
  rendererDir: __dirname,
  diagramType: 'sequence',
  defaultExample: 'cache-miss-request.sequence.json'
});

// Block layout: a renderer-sized Sequence with blocks (groups) is read at its
// actual size with horizontal scroll, so its text sizes are on-screen sizes.
const blockMode = !sequence.meta?.viewBox && (sequence.meta?.column_fit || 'spread') === 'spread'
  && asArray(sequence.groups).length > 0;
const BLOCK_TEXT = {
  message: 12.5,
  note: 10,
  label: 13,
  labelMinimum: 10,
  sublabel: 9.5,
  sublabelMinimum: 8,
  groupTitle: 11,
  segment: 11,
  step: 10,
};

const participantTextFit = blockMode
  ? { sublabelPreferred: BLOCK_TEXT.sublabel, sublabelMinimum: BLOCK_TEXT.sublabelMinimum }
  : { sublabelPreferred: 7, sublabelMinimum: 6 };

const LEGEND_CATALOG = [
  { kind: 'emphasis', className: 'a-emphasis', marker: 'arrowhead-emphasis', strokeWidth: 1.8 },
  { kind: 'return', className: 'a-default', marker: 'arrowhead', dash: '3,5' },
  { kind: 'security', className: 'a-security', marker: 'arrowhead-security' },
  { kind: 'dashed', className: 'a-dashed', marker: 'arrowhead-dashed' },
  { kind: 'default', className: 'a-default', marker: 'arrowhead' },
].map((entry) => ({
  ...entry,
  interactive: false,
  swatchWidth: 34,
  swatchGap: 9,
  label: i18nText(sequence.meta.locale, `legend.sequence.${entry.kind}`),
}));

function legendEntries() {
  const presentKinds = new Set(asArray(sequence.messages).map((message) => message.variant || 'default'));
  return resolveLegend(sequence.meta?.legend, LEGEND_CATALOG, presentKinds);
}

// The legend sits below the timeline content: the last message and its note,
// activation bars, and segment frames. Its block starts LEGEND_CONTENT_GAP
// below that content; from the block top to the canvas bottom a one-row legend
// needs LEGEND_BLOCK_HEIGHT (title glyphs, row, and the 54px baseline inset).
const LEGEND_CONTENT_GAP = 12;
const LEGEND_BLOCK_HEIGHT = 86;

// A renderer-sized spread canvas widens until every participant label fits,
// but never past the width where 7px sublabels would project below the
// desktop reading minimum; an inherently crowded row still fails below.
const spreadParticipantWidth = (canvasWidth) => Math.max(86,
  Math.min(190, Math.round((canvasWidth - 124) / Math.max(1, asArray(sequence.participants).length)) - 24));
function spreadColumnGeometry(canvasWidth, width = spreadParticipantWidth(canvasWidth)) {
  const count = Math.max(1, asArray(sequence.participants).length);
  const span = count * width + (count - 1) * 16;
  const margin = Math.max(40, Math.min(62, canvasWidth - 40 - span));
  return { width, margin, gap: count > 1 ? Math.max(width + 16, (canvasWidth - 40 - margin - width) / (count - 1)) : 108 };
}
// Evaluate the same spread coordinates and full masks used by the renderer;
// short participant names alone do not imply a compact timeline will fit.
function timelineLabelsFit(canvasWidth) {
  const { width, margin, gap } = spreadColumnGeometry(canvasWidth);
  const centers = new Map(asArray(sequence.participants).map((participant, index) => [participant.id, margin + width / 2 + index * gap]));
  const unitWidth = sequence.meta?.quality_profile === 'showcase' ? 6.6 : 5.2;
  return asArray(sequence.messages).every((message) => {
    if (!centers.has(message.from) || !centers.has(message.to)) return true;
    const center = (centers.get(message.from) + centers.get(message.to)) / 2;
    const halfWidth = Math.max(34, textUnits(message.label) * unitWidth + 12) / 2;
    return center - halfWidth >= 0 && center + halfWidth <= canvasWidth;
  }) && asArray(sequence.segments).every((segment) => 56 + Math.max(42, textUnits(segment.label) * SEGMENT_UNIT_WIDTH + 14) <= canvasWidth - 48);
}
const readableCanvasWidth = Math.floor(DESKTOP_READER_DIAGRAM_WIDTH * participantTextFit.sublabelPreferred / MIN_PROJECTED_NODE_TEXT_PX);
// Message labels are drawn in IBM Plex Sans, about 0.52em per character.
const SANS_WIDTH_FACTOR = 0.52;
// Box text is fitted with the 0.6em monospace estimate; IBM Plex Sans is about
// 0.53em wide, so the same text fits one step larger.
const SANS_FIT_SCALE = 1.08;
function sansFontSize(fitted) {
  return Math.round(fitted * SANS_FIT_SCALE * 10) / 10;
}
// Activation bars reach 5px past a lifeline; keep 3px of air beyond each one.
const LABEL_BAR_CLEARANCE = 8;
const SEGMENT_FONT_SIZE = blockMode ? BLOCK_TEXT.segment : 9;
const SEGMENT_UNIT_WIDTH = blockMode ? BLOCK_TEXT.segment * 0.58 : 5.2;
// Widen a renderer-sized canvas until each message label fits between the
// activation bars of the lanes it spans, but never past the readable width.
function labelCanvasWidth(baseWidth) {
  const participantIndex = new Map(asArray(sequence.participants).map((participant, index) => [participant.id, index]));
  const fontSize = sequence.meta?.quality_profile === 'showcase' ? 10.5 : 10;
  const labelsFit = (canvasWidth) => {
    const { gap } = spreadColumnGeometry(canvasWidth);
    return asArray(sequence.messages).every((message) => {
      const lanes = Math.abs((participantIndex.get(message.to) ?? 0) - (participantIndex.get(message.from) ?? 0));
      if (!lanes) return true;
      return textUnits(message.label) * fontSize * SANS_WIDTH_FACTOR + 8 <= lanes * gap - 2 * LABEL_BAR_CLEARANCE;
    });
  };
  if (labelsFit(baseWidth)) return baseWidth;
  for (let candidate = baseWidth + 20; candidate < readableCanvasWidth; candidate += 20) {
    if (labelsFit(candidate)) return candidate;
  }
  return Math.max(baseWidth, readableCanvasWidth);
}
// Block layout columns: boxes as wide as their 13px names, columns inside one
// block close together, and the space between blocks BLOCK_GAP_RATIO times
// wider, so a call between blocks visibly travels.
const BLOCK_SIDE_MARGIN = 62;
const BLOCK_RIGHT_MARGIN = 40;
const BLOCK_INSIDE_AIR = 14;
const BLOCK_GAP_RATIO = 2.2;
function blockParticipantWidth() {
  const needed = Math.max(...asArray(sequence.participants).map((participant) => Math.max(
    textUnits(participant.label) * BLOCK_TEXT.label * 0.6 + 8,
    participant.sublabel ? minimumNodeTextWidth(participant.sublabel, BLOCK_TEXT.sublabel) + 8 : 0,
  )));
  return Math.min(190, Math.max(86, Math.ceil(needed)));
}
function blockGaps(width) {
  const ids = asArray(sequence.participants).map((participant) => participant.id);
  const groupOf = new Map();
  asArray(sequence.groups).forEach((group) => asArray(group.participants).forEach((id) => groupOf.set(id, group.id)));
  const base = width + BLOCK_INSIDE_AIR;
  const inside = ids.slice(1).map((id, gap) => groupOf.has(id) && groupOf.get(id) === groupOf.get(ids[gap]));
  const gaps = inside.map((sameBlock) => (sameBlock ? base : base * BLOCK_GAP_RATIO));
  // A top-level label between neighbours widens its gap; inside a block only a
  // little, since a label wider than its lanes moves away from active bars.
  for (const message of asArray(sequence.messages)) {
    const from = ids.indexOf(message.from);
    const to = ids.indexOf(message.to);
    if (from < 0 || to < 0 || Math.abs(from - to) !== 1) continue;
    const gap = Math.min(from, to);
    const need = textUnits(message.label) * BLOCK_TEXT.message * SANS_WIDTH_FACTOR + 8 + 2 * LABEL_BAR_CLEARANCE;
    gaps[gap] = Math.max(gaps[gap], inside[gap] ? Math.min(need, base * 1.25) : need);
  }
  return gaps.map((gap) => Math.round(gap * 100) / 100);
}
function blockCanvasWidth() {
  const width = blockParticipantWidth();
  const span = blockGaps(width).reduce((sum, gap) => sum + gap, 0);
  return Math.ceil(BLOCK_SIDE_MARGIN + width + span + BLOCK_RIGHT_MARGIN);
}
function automaticCanvasWidth() {
  if (blockMode) return blockCanvasWidth();
  return labelCanvasWidth(participantCanvasWidth());
}
function participantCanvasWidth() {
  const participantsFit = (width) => asArray(sequence.participants).every((participant) => (
    textUnits(participant.label) * 6.8 <= width + 6
    && (!participant.sublabel || minimumNodeTextWidth(participant.sublabel, participantTextFit.sublabelMinimum) <= availableNodeTextWidth(width))
  ));
  const count = Math.max(1, asArray(sequence.participants).length);
  const columnFitMode = sequence.meta?.column_fit || 'spread';
  if (columnFitMode !== 'spread') return 920;
  if (participantsFit(spreadParticipantWidth(920))) {
    // Few-participant automatic canvases: keep readable box sizes but drop the
    // empty gutters a 920px spread leaves beside 2–3 lifelines. Authored
    // viewBoxes and the widen-for-labels path below are unchanged.
    if (count <= 3) {
      for (const candidate of [560, 640, 720, 800, 920]) {
        const box = spreadParticipantWidth(candidate);
        const span = count * box + (count - 1) * 16;
        if (box >= 86 && participantsFit(box) && candidate - 80 >= span && timelineLabelsFit(candidate)) return candidate;
      }
    }
    return 920;
  }
  const needed = Math.max(...asArray(sequence.participants).map((participant) => Math.max(
    textUnits(participant.label) * 6.8 - 6,
    participant.sublabel ? minimumNodeTextWidth(participant.sublabel, participantTextFit.sublabelPreferred) + 86 - availableNodeTextWidth(86) : 0,
  )));
  return Math.min(readableCanvasWidth, Math.max(920, Math.ceil((Math.min(190, needed) + 25) * count + 124)));
}
const automaticWidth = sequence.meta?.viewBox ? null : automaticCanvasWidth();

// Column geometry depends only on the canvas width, which is known before the
// automatic height is: notes wrap inside lane gaps, and their wrapped height
// feeds that automatic height.
// `column_fit: "spread"` widens the lanes with the viewBox instead of keeping
// the fixed 108px gap, so a wide canvas gains column distance and label room
// rather than dead space on the right. Spread is the default on both automatic
// and authored canvases; explicit fixed retains historical coordinates.
const canvasWidth = sequence.meta?.viewBox?.[0] ?? automaticWidth;
const columnFit = sequence.meta?.column_fit || 'spread';
const participantCount = Math.max(1, asArray(sequence.participants).length);
// Resolve the actual final-canvas text floor before choosing header geometry.
// Notes and automatic height must use the resulting column gaps below.
const readableMessages = sequence.meta?.quality_profile === 'showcase';
const readableAutomaticSublabel = readableMessages && automaticWidth !== null && columnFit === 'spread' && !blockMode;
const readableSublabelMinimum = readableAutomaticSublabel
  ? Math.max(participantTextFit.sublabelMinimum, Math.ceil(minimumReadableSourceTextPx(canvasWidth) * 10) / 10)
  : participantTextFit.sublabelMinimum;
const readableSublabelPreferred = Math.max(participantTextFit.sublabelPreferred, readableSublabelMinimum);

function participantSpreadGeometry() {
  const nominal = spreadColumnGeometry(canvasWidth);
  const participants = asArray(sequence.participants);
  // Preserve every already-fitting row and all authored/fixed geometry. Only
  // a failed primary label opens this bounded use of spare horizontal room.
  if (automaticWidth === null || columnFit !== 'spread'
    || !participants.some((participant) => textUnits(participant.label) * 6.8 > nominal.width + 6)) return nominal;
  const required = Math.ceil(Math.max(nominal.width, ...participants.map((participant) => Math.max(
    textUnits(participant.label) * 6.8 - 6,
    participant.sublabel ? minimumNodeTextWidth(participant.sublabel, readableSublabelMinimum)
      + nominal.width - availableNodeTextWidth(nominal.width) : 0,
  ))));
  const capacity = Math.floor(Math.min(190, (canvasWidth - 80 - (participantCount - 1) * 16) / participantCount));
  // Keep the existing real failures if ordinary text or the brand rail cannot
  // fit the minimum candidate. Do not clamp a demand into infeasible geometry.
  if (required > capacity || participants.some((participant) => brandTopRailProblem(participant, required, 8, 'Participant'))) return nominal;
  return spreadColumnGeometry(canvasWidth, required);
}

const preferredSideMargin = 62;
const spreadGeometry = participantSpreadGeometry();
const participantW = blockMode ? blockParticipantWidth() : columnFit === 'spread' ? spreadGeometry.width : 86;
// Narrow feasible frames can reduce the left margin, while ordinary frames
// keep 62px. Compute card width first so this does not change its sizing rule.
const sideMargin = blockMode ? BLOCK_SIDE_MARGIN : columnFit === 'spread'
  ? spreadGeometry.margin
  : preferredSideMargin;
// Fit the authored width when feasible, preserving a real 16px card gutter.
// Infeasible frames retain that minimum and fail the capacity check below.
const colGap = columnFit === 'spread' && participantCount > 1
  ? spreadGeometry.gap
  : 108;
const leftX = columnFit === 'spread' ? sideMargin + participantW / 2 : sideMargin;
const participantIndexById = new Map(asArray(sequence.participants).map((participant, index) => [participant.id, index]));

// Column offsets from the first lifeline: even spacing, or the block gaps.
function columnOffsetList() {
  if (!blockMode) return Array.from({ length: participantCount }, (_, index) => index * colGap);
  const offsets = [0];
  blockGaps(participantW).forEach((gap, index) => offsets.push(Math.round((offsets[index] + gap) * 100) / 100));
  return offsets;
}
const columnOffsets = columnOffsetList();

function participantX(index) {
  return leftX + columnOffsets[index];
}

// A note wraps inside one gap between neighbouring lifelines, so it never
// crosses an unrelated lifeline or activation bar (#676). Every character
// stays visible, including in image exports: long unbroken text (a URL or
// path) breaks after its punctuation, otherwise at any character.
// Notes are drawn in IBM Plex Sans; NOTE_WIDTH_FACTOR is a safe width per
// character for that font (mixed text measures about 0.52em).
const NOTE_FONT_SIZE = blockMode ? BLOCK_TEXT.note : 8.5;
const NOTE_LINE_HEIGHT = NOTE_FONT_SIZE + 4;
const NOTE_WIDTH_FACTOR = 0.55;
// The first line keeps its original position: 12px past the arrow start,
// which sits 7px from the lifeline.
const NOTE_ARROW_INSET = 7;
const NOTE_TEXT_INSET = 12;
// Activation bars reach 5px past a lifeline; keep 6px of air beyond them.
const NOTE_LIFELINE_CLEARANCE = 11;
// Spread columns share one computed gap, but subtracting floating-point column
// centres can differ in the last digits; such gaps still count as equal.
const NOTE_GAP_TOLERANCE = 0.5;
const NOTE_BREAK_AFTER = new Set(['/', '.', '-', '?', '&', '=', '#', '_']);
const noteSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let noteWordSegmenter;
const noteLayouts = new Map();

function noteTextWidth(text) {
  return textUnits(text) * NOTE_FONT_SIZE * NOTE_WIDTH_FACTOR;
}

// Index after the last punctuation break in `piece`, or its full length.
function noteBreakIndex(piece) {
  for (let index = piece.length - 1; index > 0; index -= 1) {
    if (NOTE_BREAK_AFTER.has(piece[index - 1])) return index;
  }
  return piece.length;
}

function wrapNoteText(text, width) {
  const original = wrapNoteWords(String(text).match(/\s+|\S+/gu) || [], width);
  if (!/\p{Script=Han}/u.test(text)) return original;

  // Space-only tokens can waste half a line before a Chinese phrase. Split Han
  // words, preserving other runs (identifiers, URLs, +4) and closing punctuation.
  noteWordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const words = [];
  for (const token of String(text).match(/\s+|\p{Script=Han}[\p{Script=Han}\p{Mark}]*|[^\s\p{Script=Han}]+/gu) || []) {
    if (/\p{Script=Han}/u.test(token)) {
      for (const { segment } of noteWordSegmenter.segment(token)) words.push(segment);
    } else if (/^[、。，；：！？）】》」』]+$/u.test(token) && words.length) {
      words[words.length - 1] += token;
    } else {
      words.push(token);
    }
  }
  const compact = wrapNoteWords(words, width);
  // Never grow a note or change a same-height wrap merely to rebalance lines.
  return compact.length < original.length ? compact : original;
}

function wrapNoteWords(words, width) {
  const lines = [];
  let line = '';
  const flush = () => {
    const trimmed = line.trimEnd();
    if (trimmed) lines.push(trimmed);
    line = '';
  };
  for (const word of words) {
    if (/^\s+$/u.test(word)) {
      if (line) line += ' ';
      continue;
    }
    if (noteTextWidth(line + word) <= width) {
      line += word;
      continue;
    }
    flush();
    let piece = '';
    for (const { segment } of noteSegmenter.segment(word)) {
      while (piece && noteTextWidth(piece + segment) > width) {
        const cut = noteBreakIndex(piece);
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      piece += segment;
    }
    line = piece;
  }
  flush();
  return lines;
}

// The widest gap the message spans; equal gaps resolve to the left-most one,
// where a note has always started, so notes keep their original position.
function noteGapIndex(fromIndex, toIndex) {
  const low = Math.min(fromIndex, toIndex);
  const high = Math.max(fromIndex, toIndex);
  let best = null;
  for (let gap = low; gap < high; gap += 1) {
    const width = participantX(gap + 1) - participantX(gap);
    if (!best || width > best.width + NOTE_GAP_TOLERANCE) best = { gap, width };
  }
  return best?.gap ?? null;
}

function noteRect(message) {
  const note = noteLayout(message);
  return note && { x: note.x, y: note.top, width: note.width, height: note.bottom - note.top };
}

function noteLayout(message) {
  if (noteLayouts.has(message)) return noteLayouts.get(message);
  let result = null;
  const fromIndex = participantIndexById.get(message.from);
  const toIndex = participantIndexById.get(message.to);
  if (message.note && typeof message.y === 'number' && fromIndex !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
    const gap = noteGapIndex(fromIndex, toIndex);
    const x = participantX(gap) + NOTE_ARROW_INSET + NOTE_TEXT_INSET;
    const maxWidth = Math.max(1, participantX(gap + 1) - NOTE_LIFELINE_CLEARANCE - x);
    const lines = noteTextWidth(message.note) <= maxWidth ? [message.note] : wrapNoteText(message.note, maxWidth);
    const baseline = message.y + 18;
    result = {
      x,
      baseline,
      lines,
      width: Math.max(...lines.map(noteTextWidth)),
      // Include fallback-font ascent in the same bounds used for title clearance.
      top: baseline - NOTE_FONT_SIZE * 1.2,
      bottom: message.y + 22 + (lines.length - 1) * NOTE_LINE_HEIGHT,
    };
  }
  noteLayouts.set(message, result);
  return result;
}

// Block layout spaces the steps by what each needs instead of the authored y:
// room for the step's note, then for the next label, plus room for a segment
// frame edge and title between two steps. Activation edges move with the
// steps around them; segment edges sit just after the step above (end) or
// just before the step below (start).
const STEP_AIR = 30;
const SEGMENT_EDGE_ROOM = 22;
function noteLineCount(message) {
  const fromIndex = participantIndexById.get(message.from);
  const toIndex = participantIndexById.get(message.to);
  if (!message.note || fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) return 0;
  const gap = noteGapIndex(fromIndex, toIndex);
  const x = participantX(gap) + NOTE_ARROW_INSET + NOTE_TEXT_INSET;
  const maxWidth = Math.max(1, participantX(gap + 1) - NOTE_LIFELINE_CLEARANCE - x);
  return noteTextWidth(message.note) <= maxWidth ? 1 : wrapNoteText(message.note, maxWidth).length;
}

function stepDepth(message) {
  const lines = noteLineCount(message);
  const noteBottom = lines ? 22 + (lines - 1) * NOTE_LINE_HEIGHT : 6;
  // The detail toggle sits 13px below the arrow with a 7px radius.
  return Math.max(noteBottom, asArray(message.details).length ? 20 : 0);
}

function compactTimeline() {
  const messages = asArray(sequence.messages).filter((message) => typeof message.y === 'number')
    .sort((a, b) => a.y - b.y);
  if (!messages.length) return;
  const segments = asArray(sequence.segments);
  const oldYs = messages.map((message) => message.y);
  const newYs = [oldYs[0]];
  for (let index = 1; index < messages.length; index += 1) {
    const [low, high] = [oldYs[index - 1], oldYs[index]];
    const crossing = (edge) => segments.some((segment) => segment[edge] > low && segment[edge] < high);
    const edges = (crossing('to') ? 1 : 0) + (crossing('from') ? 1 : 0);
    newYs.push(newYs[index - 1] + stepDepth(messages[index - 1]) + STEP_AIR + edges * SEGMENT_EDGE_ROOM);
  }
  const anchorIndex = (y) => oldYs.findIndex((old) => old >= y);
  // Any other y moves by interpolation between the steps around it.
  const mapY = (y) => {
    const next = anchorIndex(y);
    if (next === 0) return y;
    if (next < 0) return y + newYs[newYs.length - 1] - oldYs[oldYs.length - 1];
    if (oldYs[next] === y) return newYs[next];
    const ratio = (y - oldYs[next - 1]) / (oldYs[next] - oldYs[next - 1]);
    return newYs[next - 1] + ratio * (newYs[next] - newYs[next - 1]);
  };
  const mapSegmentEdge = (y, edge) => {
    const next = anchorIndex(y);
    if (next <= 0) return mapY(y);
    if (oldYs[next] === y) return newYs[next];
    return edge === 'to'
      ? newYs[next - 1] + stepDepth(messages[next - 1]) + 8
      : newYs[next] - 28;
  };
  for (const activation of asArray(sequence.activations)) {
    activation.from = mapY(activation.from);
    activation.to = mapY(activation.to);
  }
  for (const segment of segments) {
    segment.from = mapSegmentEdge(segment.from, 'from');
    segment.to = mapSegmentEdge(segment.to, 'to');
  }
  messages.forEach((message, index) => {
    message.y = newYs[index];
  });
  noteLayouts.clear();
}
if (blockMode) compactTimeline();

const contentBottom = Math.max(
  0,
  ...asArray(sequence.messages).map((message) => (message.note
    ? noteLayout(message)?.bottom ?? message.y + 22
    : message.y + 6)),
  ...asArray(sequence.activations).map((activation) => activation.to),
  ...asArray(sequence.segments).map((segment) => segment.to),
);
function legendRequiredHeight(width) {
  const entries = legendEntries();
  if (!entries.length) return 0;
  return Math.ceil(contentBottom + LEGEND_CONTENT_GAP + LEGEND_BLOCK_HEIGHT
    + legendFootprint(entries, { width: width - 80 }).extraHeight);
}
// A renderer-sized canvas grows to keep the legend clear of late messages and
// shrinks when the timeline is short. Keep a readable minimum band (lifelineTop
// 142 + 120px timeline + 65px footer = 327); honor authored canvases below.
const SEQUENCE_MIN_AUTO_HEIGHT = 327;
// Timeline clearance is independent of legend visibility. Messages need 18px
// before the lifeline bottom; notes, activations and frames need their footer.
const timelineRequiredHeight = Math.max(contentBottom + 65,
  ...asArray(sequence.messages).map((message) => message.y + 18 + 65));
const automaticHeight = Math.max(SEQUENCE_MIN_AUTO_HEIGHT, timelineRequiredHeight, legendRequiredHeight(automaticWidth));
const viewBox = sequence.meta?.viewBox || [automaticWidth, automaticHeight];
// The timeline scales with viewBox height: a taller viewBox gains message room,
// a shorter one shrinks the readable band (validated below) instead of clipping.

// Showcase is the fast-authoring default; standard retains legacy label geometry.
// Layout and checks keep the monospace estimate (messageUnitWidth). Labels are
// drawn in the narrower IBM Plex Sans, so the drawn plate hugs the text instead
// of covering nearby lifelines and activation bars.
const messageFontSize = blockMode ? BLOCK_TEXT.message : readableMessages ? 10.5 : 10;
const messageUnitWidth = blockMode ? BLOCK_TEXT.message * 0.6 : readableMessages ? 6.6 : 5.2;
const layout = {
  topY: 72,
  participantW,
  // Keep a separate top rail for the 11px semantic sigil and 16px brand mark.
  // Literal labels retain their fitted font size and full authored wording.
  participantH: 60,
  participantLabelY: 36,
  participantSublabelY: 50,
  lifelineTop: 142,
  lifelineBottom: viewBox[1] - 65,
  legendY: viewBox[1] - 54,
  leftX,
  colGap,
  labelH: readableMessages ? 18 : 16,
};

const participantBoxWidthNote = automaticWidth
  ? `participant boxes are ${participantW}px: the automatic ${viewBox[0]}px canvas cannot widen further without its 7px sublabels falling below the desktop reading minimum, so keep meta.viewBox omitted`
  : columnFit === 'spread'
    ? `participant boxes are ${participantW}px for this viewBox width and ${participantCount} participants`
    : `participant boxes are a fixed ${participantW}px unless meta.column_fit is "spread"`;

const arrowClass = {
  ...arrowClassMap,
  return: ['a-default', 'arrowhead']
};

const participants = new Map(asArray(sequence.participants).map((participant, index) => [
  participant.id,
  {
    ...participant,
    index,
    cx: participantX(index),
    x: participantX(index) - layout.participantW / 2,
    y: layout.topY,
    width: layout.participantW,
    height: layout.participantH,
    cy: layout.topY + layout.participantH / 2
  }
]));

function messageGeometry(message) {
  const from = participants.get(message.from);
  const to = participants.get(message.to);
  if (!from || !to || typeof message.y !== 'number') return null;
  const direction = to.cx > from.cx ? 1 : -1;
  const start = from.cx + direction * 7;
  const end = to.cx - direction * 7;
  return { start, end, center: (start + end) / 2 };
}

// Activation bar span [left, right] of a participant at time y, or null.
function activeBarAt(participantId, y) {
  const participant = participants.get(participantId);
  if (!participant) return null;
  const active = asArray(sequence.activations).some((activation) => activation.participant === participantId
    && activation.from - 2 <= y && y <= activation.to + 2);
  return active ? { left: participant.cx - 5, right: participant.cx + 5 } : null;
}

// A label wider than the room between the activation bars of its own lanes
// moves toward the side without an active bar, so its text does not sit on top
// of that bar. It stays centred when both or neither end has a bar, or when the
// moved label would reach another participant's active bar.
function messageLabelCenter(message, geometry) {
  const from = participants.get(message.from);
  const to = participants.get(message.to);
  const width = textUnits(message.label) * messageFontSize * SANS_WIDTH_FACTOR + 8;
  const [low, high] = from.cx < to.cx ? [from, to] : [to, from];
  const lowBar = activeBarAt(low.id, message.y);
  const highBar = activeBarAt(high.id, message.y);
  const minX = lowBar ? lowBar.right + 3 : low.cx;
  const maxX = highBar ? highBar.left - 3 : high.cx;
  if (width <= maxX - minX || Boolean(lowBar) === Boolean(highBar)) return geometry.center;
  const center = lowBar ? minX + width / 2 : maxX - width / 2;
  const reachesOtherBar = [...participants.keys()]
    .filter((id) => id !== low.id && id !== high.id)
    .map((id) => activeBarAt(id, message.y))
    .some((bar) => bar && bar.left - 3 < center + width / 2 && center - width / 2 < bar.right + 3);
  return reachesOtherBar ? geometry.center : center;
}

function messageLabelBox(message, relationIndex = null) {
  const geometry = messageGeometry(message);
  if (!geometry) return null;
  const width = Math.max(34, textUnits(message.label) * messageUnitWidth + 12);
  return {
    relation: message,
    relationIndex,
    label: message.label,
    x: messageLabelCenter(message, geometry) - width / 2,
    y: message.y - 20,
    width,
    height: layout.labelH,
  };
}

function messageRouteBox(message) {
  const geometry = messageGeometry(message);
  if (!geometry) return null;
  return {
    x: Math.min(geometry.start, geometry.end),
    y: message.y - 2,
    width: Math.abs(geometry.end - geometry.start),
    height: 4,
  };
}

// Message labels, routes and notes a segment label must not cover, with the
// source path of each so a failure can name what it hides.
function segmentLabelOccupants() {
  return asArray(sequence.messages).flatMap((message, messageIndex) => [
    { kind: 'message label', path: `/messages/${messageIndex}/label`, message, rect: messageLabelBox(message) },
    { kind: 'message route', path: `/messages/${messageIndex}/y`, message, rect: messageRouteBox(message) },
    { kind: 'note', path: `/messages/${messageIndex}/note`, message, rect: noteRect(message) },
  ]).filter((occupant) => occupant.rect);
}

function legacySegmentLabelBox(segment) {
  const labelW = Math.max(42, textUnits(segment.label) * SEGMENT_UNIT_WIDTH + 14);
  const occupied = segmentLabelOccupants();
  const label = { x: 56, y: segment.from - 22, width: labelW, height: 18 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!occupied.some(({ rect }) => rectsOverlap(label, rect, 2))) break;
    label.y -= 22;
  }
  if (!segmentLabelMisplaced(label, segment)) return label;
  // Abutting segments can leave no room on the border: the badge climbed
  // behind the participant headers or into the previous segment, where it
  // names the wrong phase. Its own frame's top-left corner, clear of messages,
  // names the right one.
  // Another segment's title normally sits on that segment's own top border,
  // so its strip is taken too.
  const otherTitles = asArray(sequence.segments).filter((other) => other !== segment)
    .map((other) => ({ x: 56, y: other.from - 22, width: Math.max(42, textUnits(other.label) * SEGMENT_UNIT_WIDTH + 14), height: 18 }));
  const inside = { x: 56, y: segment.from + 4, width: labelW, height: 18 };
  for (let attempt = 0; attempt < 4 && inside.y + inside.height <= segment.to - 2; attempt += 1) {
    if (!segmentLabelMisplaced(inside, segment)
      && ![...occupied.map(({ rect }) => rect), ...otherTitles, ...participants.values()].some((rect) => rectsOverlap(inside, rect, 2))) return inside;
    inside.y += 22;
  }
  return label;
}

function segmentLabelBox(segment) {
  const label = legacySegmentLabelBox(segment);
  const headers = [...participants.values()];
  const coveredHeaders = headers.filter((header) => rectsOverlap(label, header, 0));
  if (!coveredHeaders.length || label.y + label.height > segment.from) return label;

  const others = asArray(sequence.segments).filter((other) => other !== segment);
  // Only the unique first, non-overlapping phase gets this local adjustment.
  // Nested phases keep their authored bounds and the existing title policy.
  if (others.some((other) => other.from <= segment.from
    || (other.from < segment.to && other.to > segment.from))) return label;

  const candidate = { ...label, y: Math.max(...coveredHeaders.map((header) => header.y + header.height)) + 2 };
  const bottom = candidate.y + candidate.height;
  // The badge must still touch its own top border, before the first message;
  // moving it deep into the phase would name the wrong part of the timeline.
  if (candidate.y > segment.from || bottom < segment.from || bottom > segment.to - 2) return label;

  const obstacles = [
    ...segmentLabelOccupants().map(({ rect }) => rect),
    ...headers,
    // Use actual legacy placements: another title may have climbed above its
    // nominal slot. Calling the unchanged helper keeps this non-recursive.
    ...others.map(legacySegmentLabelBox),
  ];
  if (!obstacles.some((rect) => rectsOverlap(candidate, rect, 2))) return candidate;

  // Only this blocked header-clear strip gains a horizontal fallback. Keep
  // successful legacy placements intact, including their activation policy.
  const fallbackObstacles = [
    ...obstacles,
    ...asArray(sequence.activations).flatMap((activation) => {
      const participant = participants.get(activation.participant);
      return participant ? [{
        x: participant.cx - 5, y: activation.from,
        width: 10, height: activation.to - activation.from,
      }] : [];
    }),
  ];
  // Every free interval on this strip starts at the left frame inset or just
  // beyond an obstacle. Scan those finite boundaries instead of pixel steps.
  const boundaries = [...new Set([
    candidate.x,
    ...fallbackObstacles
      .filter((rect) => candidate.y < rect.y + rect.height + 2
        && rect.y < candidate.y + candidate.height + 2)
      .map((rect) => rect.x + rect.width + 2),
  ])].filter((x) => x >= candidate.x && x + candidate.width <= viewBox[0] - 48)
    .sort((a, b) => a - b);
  for (const x of boundaries) {
    const shifted = { ...candidate, x };
    if (!fallbackObstacles.some((rect) => rectsOverlap(shifted, rect, 2))) return shifted;
  }
  return label;
}

// Whether moving one message to `y` keeps it readable: inside the timeline,
// 28px from messages sharing its horizontal span, and clear of every other
// label, route and note. Used to offer only repairs that hold.
function messageFitsAt(messageIndex, y) {
  const messages = asArray(sequence.messages);
  if (y < layout.lifelineTop + 18) return false;
  // An automatic canvas recalculates its height after this edit; an authored
  // canvas must still fit the suggested position without a second repair.
  if (sequence.meta?.viewBox && y > layout.lifelineBottom - 18) return false;
  const span = (message) => {
    const from = participants.get(message.from)?.cx;
    const to = participants.get(message.to)?.cx;
    return [Math.min(from, to), Math.max(from, to)];
  };
  const moved = { ...messages[messageIndex], y };
  const [left, right] = span(moved);
  const movedRects = [messageLabelBox(moved), messageRouteBox(moved), noteRect(moved)].filter(Boolean);
  return messages.every((other, otherIndex) => {
    if (otherIndex === messageIndex || typeof other.y !== 'number') return true;
    const [otherLeft, otherRight] = span(other);
    if (Math.abs(other.y - y) < 28 && left < otherRight && otherLeft < right) return false;
    const otherRects = [messageLabelBox(other), messageRouteBox(other), noteRect(other)].filter(Boolean);
    return !movedRects.some((rect) => otherRects.some((otherRect) => rectsOverlap(rect, otherRect, 2)));
  });
}

// The first occupant the segment label still covers after its upward steps.
function segmentLabelBlocker(segment) {
  const label = segmentLabelBox(segment);
  return segmentLabelOccupants().find(({ rect }) => rectsOverlap(label, rect, 2)) || null;
}

// A badge on its frame's top border is the intended title. It stops naming
// that frame once it hides mostly behind the participant headers, or once
// message labels pushed it up into another segment.
function segmentLabelMisplaced(label, segment) {
  const half = label.height / 2;
  if (layout.topY + layout.participantH - label.y > half) return true;
  if (label.y >= segment.from - 22) return false;
  return asArray(sequence.segments).some((other) => other !== segment
    && Math.min(label.y + label.height, other.to) - Math.max(label.y, other.from) > half);
}

const compositionFrames = asArray(sequence.segments).map((segment, index) => ({
  id: index,
  label: segment.label,
  kind: 'segment',
  x: 48,
  y: segment.from,
  width: viewBox[0] - 96,
  height: segment.to - segment.from,
  radius: 10,
}));

function messagePath(message) {
  return {
    points: participants.has(message.from) && participants.has(message.to)
      ? [[participants.get(message.from).cx, message.y], [participants.get(message.to).cx, message.y]]
      : []
  };
}

function validateSequence() {
  const problems = [];
  const diagnostics = [];
  if (participants.size !== asArray(sequence.participants).length) problems.push('Participant ids must be unique.');

  if (layout.lifelineBottom - layout.lifelineTop < 120) {
    problems.push(`viewBox height ${viewBox[1]} leaves under 120px of timeline — set meta.viewBox[1] to at least ${layout.lifelineTop + 120 + 65}.`);
  }

  for (const participant of participants.values()) {
    const participantIndex = asArray(sequence.participants).findIndex((entry) => entry.id === participant.id);
    const participantProblem = (field, message, evidence, supportedFixes) => {
      problems.push(message);
      diagnostics.push({
        code: `sequence/participant-${field}-overflow`, severity: 'error', message,
        subject: { diagramType: 'sequence', nodeId: participant.id, path: `/participants/${participantIndex}/${field}` },
        evidence: { viewBoxWidth: viewBox[0], participantWidth: layout.participantW, ...evidence },
        supportedFixes,
      });
    };
    const estLabelW = textUnits(participant.label) * 6.8;
    if (estLabelW > layout.participantW + 6) {
      const message = automaticWidth
        ? `Label "${participant.label}" (~${Math.round(estLabelW)}px) is wider than component "${participant.id}" — shorten it to at most ${Math.floor((layout.participantW + 6) / 6.8)} text units (CJK counts 2; ${participantBoxWidthNote}).`
        : `Label "${participant.label}" (~${Math.round(estLabelW)}px) is wider than component "${participant.id}" (${layout.participantW}px) — shorten the label or widen the participant box.`;
      participantProblem('label', message, { text: participant.label, requiredWidth: estLabelW, availableWidth: layout.participantW + 6 },
        ['shorten the participant label while preserving its role', ...(columnFit === 'fixed' ? ['set meta.column_fit to "spread" if fixed coordinates are not required'] : [])]);
    }
    const brandRailProblem = brandTopRailProblem(participant, layout.participantW, 8, 'Participant');
    if (brandRailProblem) problems.push(brandRailProblem);
    // sublabel renders as a single unwrapped <text>; shrink-to-fit handles the
    // ordinary case, this rejects what it cannot rescue.
    if (participant.sublabel) {
      const availableTextW = availableNodeTextWidth(layout.participantW);
      const minimumW = minimumNodeTextWidth(participant.sublabel, readableSublabelMinimum);
      if (minimumW > availableTextW) {
        const minimumDescription = readableAutomaticSublabel
          ? `${readableSublabelMinimum}px minimum that stays readable on this ${viewBox[0]}px canvas`
          : `${readableSublabelMinimum}px legible minimum`;
        const message = `Sublabel "${participant.sublabel}" needs ~${Math.ceil(minimumW)}px at the ${minimumDescription}, but participant "${participant.id}" provides ${availableTextW}px — shorten the sublabel (${participantBoxWidthNote}).`;
        participantProblem('sublabel', message, { text: participant.sublabel, requiredWidth: minimumW, availableWidth: availableTextW, minimumFontPx: readableSublabelMinimum },
          ['shorten the participant sublabel while preserving its role or protocol; move supplementary detail into a card', ...(columnFit === 'fixed' ? ['set meta.column_fit to "spread" if fixed coordinates are not required'] : [])]);
      }
    }
  }

  const messageList = asArray(sequence.messages);
  const participantList = asArray(sequence.participants);
  const participantOrder = new Map(participantList.map((p, index) => [p.id, index]));
  for (const message of messageList) {
    const messageIndex = messageList.indexOf(message);
    for (const [field, endpoint] of [['from', 'source'], ['to', 'target']]) {
      if (participants.has(message[field])) continue;
      const problem = `Message "${message.label}" references unknown ${endpoint} "${message[field]}".`;
      const otherField = field === 'from' ? 'to' : 'from';
      const anchorOrder = participantOrder.get(message[otherField]) ?? 0;
      const candidates = [...participantOrder.keys()]
        .filter((id) => id !== message[otherField])
        .sort((a, b) => Math.abs(participantOrder.get(a) - anchorOrder) - Math.abs(participantOrder.get(b) - anchorOrder));
      diagnostics.push({
        code: 'sequence/unknown-endpoint', severity: 'error', message: problem,
        subject: {
          diagramType: 'sequence',
          message: message.label ?? null,
          path: `/messages/${messageIndex}/${field}`,
          from: message.from,
          to: message.to,
        },
        evidence: { endpoint, unknownNodeId: message[field], availableNodeIds: candidates },
        supportedFixes: candidates.slice(0, 3).map((id) => `set /messages/${messageIndex}/${field} to verified node id "${id}"`),
      });
      problems.push(problem);
    }
    if (typeof message.y !== 'number') problems.push(`Message "${message.label}" must provide a numeric y.`);
    if (message.y < layout.lifelineTop + 18 || message.y > layout.lifelineBottom - 18) {
      problems.push(`Message "${message.label}" sits outside the readable timeline — keep y between ${layout.lifelineTop + 18} and ${layout.lifelineBottom - 18}.`);
    }
    if (participants.has(message.from) && participants.has(message.to)) {
      if (message.from === message.to) {
        const problem = `Message "${message.label}" is a self-message on participant "${message.from}"; this Sequence renderer supports only messages between distinct participants. Participant spacing cannot repair it. Preserve the internal step's meaning and order in a supported representation such as a note on a real message or a card; do not invent a participant.`;
        diagnostics.push({
          code: 'sequence/self-message-unsupported', severity: 'error', message: problem,
          subject: {
            diagramType: 'sequence',
            message: message.label,
            collection: 'messages',
            index: messageIndex,
            path: `/messages/${messageIndex}`,
            ...(message.id ? { id: message.id } : {}),
            from: message.from,
            to: message.to,
            fromPath: `/messages/${messageIndex}/from`,
            toPath: `/messages/${messageIndex}/to`,
          },
          evidence: {
            participant: message.from,
            participantPath: `/participants/${participantOrder.get(message.from)}`,
            y: message.y,
            supportedMessageGeometry: 'horizontal-between-distinct-participants',
          },
          supportedFixes: [],
        });
        problems.push(problem);
      } else {
        const distance = Math.abs(participants.get(message.to).cx - participants.get(message.from).cx);
        if (distance < 60) problems.push(`Message "${message.label}" spans ${Math.round(distance)}px (minimum 60px) — give its participants more column distance.`);
      }
    }
  }

  // Participant headers are opaque nodes. Lifelines, activation bars, and
  // segment bands remain intentional pass-through geometry and are excluded.
  problems.push(...cleanFlowProblems({
    relations: sequence.messages,
    obstacles: participants.values(),
    pathFor: messagePath,
    diagramType: 'sequence',
    relationCollection: 'messages',
    obstacleKind: 'participant header',
    clearance: 0,
    routeHint: 'move the message y below the participant headers or reorder participants'
  }));
  problems.push(...cleanCrossingProblems({
    relations: sequence.messages,
    endpointIds: new Set(participants.keys()),
    pathFor: messagePath,
    diagramType: 'sequence',
    relationCollection: 'messages',
    profile: sequence.meta?.quality_profile,
    routeHint: 'separate the message y values; lifeline crossings remain allowed'
  }));
  problems.push(...cleanAmbiguousCorridorProblems({
    relations: sequence.messages,
    endpointIds: new Set(participants.keys()),
    pathFor: messagePath,
    diagramType: 'sequence',
    relationCollection: 'messages',
    profile: sequence.meta?.quality_profile,
    routeHint: 'separate the message y values so unrelated messages do not visually merge'
  }));
  problems.push(...cleanBorderRunProblems({
    relations: sequence.messages,
    endpointIds: new Set(participants.keys()),
    frames: compositionFrames,
    pathFor: messagePath,
    diagramType: 'sequence',
    relationCollection: 'messages',
    profile: sequence.meta?.quality_profile,
    routeHint: 'move the message y so it crosses a segment boundary perpendicularly or stays clearly inside the segment'
  }));
  problems.push(...cleanRouteRhythmProblems({
    relations: sequence.messages,
    endpointIds: new Set(participants.keys()),
    pathFor: messagePath,
    diagramType: 'sequence',
    relationCollection: 'messages',
    profile: sequence.meta?.quality_profile,
    routeHint: 'increase participant spacing or simplify message routing so every turn has room to read'
  }));

  // Vertical crowding only matters when the arrows share horizontal space;
  // disjoint arrows may legitimately run in parallel rows.
  const placed = asArray(sequence.messages)
    .filter((m) => participants.has(m.from) && participants.has(m.to))
    .map((m) => ({
      label: m.label,
      y: m.y,
      x1: Math.min(participants.get(m.from).cx, participants.get(m.to).cx),
      x2: Math.max(participants.get(m.from).cx, participants.get(m.to).cx)
    }))
    .sort((a, b) => a.y - b.y);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length && placed[j].y - placed[i].y < 28; j += 1) {
      if (placed[i].x1 < placed[j].x2 && placed[j].x1 < placed[i].x2) {
        problems.push(`Messages "${placed[i].label}" and "${placed[j].label}" are less than 28px apart and share horizontal space — spread their y values.`);
      }
    }
  }

  // Label masks can extend well past the arrow span, so check the actual
  // label rectangles too — tangent arrows with long labels still collide.
  const labelRects = asArray(sequence.messages)
    .map((m, messageIndex) => messageLabelBox(m, messageIndex))
    .filter(Boolean);
  for (let i = 0; i < labelRects.length; i += 1) {
    for (let j = i + 1; j < labelRects.length; j += 1) {
      if (rectsOverlap(labelRects[i], labelRects[j], -2)) {
        problems.push(`Labels "${labelRects[i].label}" and "${labelRects[j].label}" overlap — spread their message y values or shorten the labels.`);
      }
    }
  }
  problems.push(...cleanLabelRouteClearanceProblems({
    relations: sequence.messages,
    labels: labelRects,
    endpointIds: new Set(participants.keys()),
    pathFor: messagePath,
    diagramType: 'sequence',
    relationCollection: 'messages',
    profile: sequence.meta?.quality_profile,
    routeHint: 'spread the message y values, shorten the label, or reorder participants so the adjacent route stays visible'
  }));
  problems.push(...cleanLabelCanvasContainmentProblems({
    labels: labelRects,
    viewBox,
    diagramType: 'sequence',
    relationCollection: 'messages',
    profile: sequence.meta?.quality_profile,
    routeHint: 'shorten the label, reorder participants, or enlarge meta.viewBox',
  }));

  // A wrapped note keeps every character (#676), so a note that still reaches a
  // later message or the canvas bottom needs the diagram changed; authored y
  // values and viewBox stay as written. Showcase only, so standard keeps
  // accepting existing diagrams.
  const report = (problem, detail) => {
    problems.push(problem);
    diagnostics.push({ severity: 'error', message: problem, ...detail });
  };
  const bounds = (rect) => ({
    x: Math.round(rect.x * 10) / 10,
    y: Math.round(rect.y * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10,
  });
  if (readableMessages) {
    const messages = asArray(sequence.messages);
    const noteFloor = layout.lifelineBottom + 20;
    messages.forEach((message, messageIndex) => {
      const note = noteLayout(message);
      if (!note) return;
      const lines = note.lines.length === 1 ? '1 line' : `${note.lines.length} lines`;
      const bottom = Math.ceil(note.bottom);
      const ownRect = noteRect(message);
      const subject = {
        diagramType: 'sequence',
        message: message.label ?? null,
        path: `/messages/${messageIndex}/note`,
        from: message.from,
        to: message.to,
      };
      if (note.bottom > noteFloor) {
        // A visible legend needs its own room below the note as well.
        const requiredHeight = Math.max(Math.ceil(viewBox[1] + note.bottom - noteFloor), legendRequiredHeight(viewBox[0]));
        const fix = sequence.meta?.viewBox
          ? `set /meta/viewBox/1 to ${requiredHeight}`
          : `set /meta/viewBox to [${viewBox[0]}, ${requiredHeight}]`;
        report(`Note on message "${message.label}" wraps to ${lines} and ends at y=${bottom}, below the canvas content limit y=${noteFloor} — set meta.viewBox[1] to at least ${requiredHeight}, move the message up, or shorten the note.`, {
          code: 'sequence/note-canvas-limit',
          subject,
          evidence: { lines: note.lines.length, note: bounds(ownRect), canvasLimitY: noteFloor, viewBoxHeight: viewBox[1], requiredViewBoxHeight: requiredHeight },
          supportedFixes: [fix],
        });
      }
      const blocker = messages
        .map((other, otherIndex) => {
          if (otherIndex === messageIndex || typeof other.y !== 'number' || other.y <= message.y) return null;
          const hit = [
            ['message label', messageLabelBox(other)],
            ['message route', messageRouteBox(other)],
            ['note', noteRect(other)],
          ].find(([, rect]) => rect && rectsOverlap(ownRect, rect, 2));
          return hit ? { message: other, index: otherIndex, kind: hit[0], rect: hit[1] } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.message.y - b.message.y)[0];
      if (!blocker) return;
      const requiredY = Math.ceil(note.bottom + 22);
      const blockerPath = `/messages/${blocker.index}/y`;
      report(`Note on message "${message.label}" wraps to ${lines} (down to y=${bottom}) and reaches message "${blocker.message.label}" at y=${blocker.message.y} — move "${blocker.message.label}" and later messages down so it sits at y=${requiredY} or below, or shorten the note.`, {
        code: 'sequence/note-overlap',
        subject,
        evidence: {
          lines: note.lines.length,
          note: bounds(ownRect),
          blocker: { message: blocker.message.label ?? null, path: blockerPath, y: blocker.message.y, kind: blocker.kind, bounds: bounds(blocker.rect) },
          requiredY,
        },
        supportedFixes: messageFitsAt(blocker.index, requiredY) ? [`set ${blockerPath} to ${requiredY}`] : [],
      });
    });
  }

  asArray(sequence.segments).forEach((segment, segmentIndex) => {
    if (segment.to <= segment.from) {
      problems.push(`Segment "${segment.label}" has invalid y range (from ${segment.from} to ${segment.to}) — "to" must be greater than "from".`);
    }
    if (segment.from < layout.topY || segment.to > layout.lifelineBottom + 20) {
      problems.push(`Segment "${segment.label}" extends outside the canvas — keep its y range between ${layout.topY} and ${layout.lifelineBottom + 20}.`);
    }
    // A frame edge may pass behind a masked message label, but an edge that
    // runs along the arrow itself leaves the reader unable to tell which phase
    // the message belongs to.
    if (sequence.meta?.quality_profile === 'showcase') {
      for (const edge of ['from', 'to']) {
        const border = segment[edge];
        const cut = asArray(sequence.messages).filter((message) => typeof message.y === 'number'
          && Math.abs(border - message.y) < 4);
        for (const message of cut) {
          const problem = `Segment "${segment.label}" ${edge === 'from' ? 'top' : 'bottom'} edge at y ${border} runs along message "${message.label}" (arrow at y ${message.y}) — move the edge to at least ${message.y + 4} to leave the message above it, or to at most ${message.y - 4} to leave it below.`;
          const segmentIndex = asArray(sequence.segments).indexOf(segment);
          problems.push(problem);
          diagnostics.push({
            code: 'sequence/segment-message-border-run', severity: 'error', message: problem,
            subject: { diagramType: 'sequence', collection: 'segments', index: segmentIndex, path: `/segments/${segmentIndex}/${edge}` },
            evidence: { segmentLabel: segment.label, edge, borderY: border, messageIndex: messageList.indexOf(message), messageLabel: message.label, messageY: message.y, minimumClearancePx: 4 },
            supportedFixes: [`set /segments/${segmentIndex}/${edge} to at least ${message.y + 4} to leave the message above it`, `set /segments/${segmentIndex}/${edge} to at most ${message.y - 4} to leave the message below it`],
          });
        }
      }
    }
    const labelBox = segmentLabelBox(segment);
    for (const other of asArray(sequence.segments)) {
      if (other === segment || asArray(sequence.segments).indexOf(other) < asArray(sequence.segments).indexOf(segment)) continue;
      if (rectsOverlap(labelBox, segmentLabelBox(other), 0)) {
        problems.push(`Segment labels "${segment.label}" and "${other.label}" overlap — leave more room between the segments' messages near their shared border, or shorten a label.`);
      }
    }
    const availableWidth = Math.max(0, viewBox[0] - 48 - labelBox.x);
    if (labelBox.x + labelBox.width > viewBox[0] - 48) {
      const requiredWidth = Math.ceil(labelBox.x + labelBox.width + 48);
      problems.push(`Segment "${segment.label}" label (~${Math.round(labelBox.width)}px) exceeds the segment frame's available width (${availableWidth}px) — shorten the label or increase meta.viewBox[0] to at least ${requiredWidth}.`);
    }
    // Segment labels are drawn above messages and notes and step up to stay
    // clear of them; in showcase, a label left covering any of them fails.
    const covered = readableMessages ? segmentLabelBlocker(segment) : null;
    if (covered) {
      // Offer the nearest start whose label lands clear, inside the segment.
      let clearFrom = null;
      for (let distance = 1; distance <= 300 && clearFrom === null; distance += 1) {
        for (const candidate of [segment.from + distance, segment.from - distance]) {
          if (candidate < layout.topY || candidate >= segment.to) continue;
          if (!segmentLabelBlocker({ ...segment, from: candidate })) {
            clearFrom = candidate;
            break;
          }
        }
      }
      const fromPath = `/segments/${segmentIndex}/from`;
      report(`Segment "${segment.label}" label would cover the ${covered.kind} of message "${covered.message.label}" — move the segment start (from: ${segment.from}) or that message so they are further apart${covered.kind === 'note' ? ', or shorten the note' : ''}.`, {
        code: 'sequence/segment-label-overlap',
        subject: { diagramType: 'sequence', segment: segment.label ?? null, path: fromPath },
        evidence: {
          label: bounds(labelBox),
          attempts: 4,
          covered: { kind: covered.kind, message: covered.message.label ?? null, path: covered.path, bounds: bounds(covered.rect) },
        },
        supportedFixes: clearFrom === null ? [] : [`set ${fromPath} to ${clearFrom}`],
      });
    }
  });

  for (const activation of asArray(sequence.activations)) {
    if (!participants.has(activation.participant)) problems.push(`Activation references unknown participant "${activation.participant}".`);
    if (activation.to <= activation.from) problems.push(`Activation for "${activation.participant}" has invalid time range — "to" must be greater than "from".`);
  }

  const lastParticipant = asArray(sequence.participants)[asArray(sequence.participants).length - 1];
  if (lastParticipant && participants.get(lastParticipant.id).cx + layout.participantW / 2 > viewBox[0] - 40) {
    const requiredWidth = Math.ceil(participants.get(lastParticipant.id).cx + layout.participantW / 2 + 40);
    problems.push(`Participants exceed viewBox width — set meta.viewBox[0] to at least ${requiredWidth} or remove a participant.`);
  }

  // Showcase must not silently drop the implicit legend because late content
  // leaves no room for it; give the exact canvas height instead.
  const legendHeight = legendRequiredHeight(viewBox[0]);
  if (sequence.meta?.quality_profile === 'showcase' && sequence.meta?.legend === undefined
    && legendHeight > viewBox[1] && !measureLegend(legendEntries(), legendLayout())) {
    problems.push(`Sequence content ends at y=${contentBottom}, leaving no room for the legend below it — set meta.viewBox[1] to at least ${legendHeight} or omit meta.viewBox so the canvas grows.`);
  }

  problems.push(...groupProblems());

  if (problems.length) {
    throwDiagnosticProblems('Sequence layout validation failed', problems, {
      subject: { diagramType: 'sequence' },
      diagnostics,
    });
  }
}

function renderParticipant(participant) {
  const fill = componentFill[participant.type] || 'c-external';
  const hasSub = participant.sublabel != null && participant.sublabel !== '';
  const sub = hasSub
    ? `\n          <text data-detail="context" x="${participant.cx}" y="${layout.topY + layout.participantSublabelY}" class="t-muted" font-size="${sansFontSize(fittedNodeFontSize(participant.sublabel, layout.participantW, readableSublabelPreferred, readableSublabelMinimum))}" text-anchor="middle">${esc(participant.sublabel)}</text>`
    : '';
  const brand = renderBrandMark(participant, { x: participant.x + layout.participantW - 22, y: layout.topY + 6 });
  const labelFontSize = blockMode
    ? fittedNodeFontSize(participant.label, brandLabelFitWidth(participant, layout.participantW), BLOCK_TEXT.label, BLOCK_TEXT.labelMinimum)
    : fittedNodeFontSize(participant.label, brandLabelFitWidth(participant, layout.participantW), 11, 8);
  const passport = {
    kind: participant.type,
    sublabel: participant.sublabel,
    context: i18nText(sequence.meta.locale, 'node.context.sequence'),
    ...brandMetadataFor(participant),
  };
  return `        <g ${focusNodeAttrs(participant.id, participant.label, passport, sequence.meta.locale)}>
          ${focusNodeTitle(participant.label, passport)}
          <rect x="${participant.x}" y="${layout.topY}" width="${layout.participantW}" height="${layout.participantH}" rx="6" class="c-mask"/>
          <rect x="${participant.x}" y="${layout.topY}" width="${layout.participantW}" height="${layout.participantH}" rx="6" class="${fill}"${animateAttr(sequence.meta, 'node', participant.index)} stroke-width="1.5"/>
          ${renderSemanticSigil(participant.type, { icon: participant.icon, x: participant.x + 6, y: layout.topY + 6 })}${brand ? `\n          ${brand}` : ''}
          <text data-node-label=""${hasSub ? ' data-detail-anchor=""' : ''} x="${participant.cx}" y="${layout.topY + layout.participantLabelY}" class="t-primary" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${esc(participant.label)}</text>${sub}
        </g>`;
}

// Lifelines never enter the legend band. The legend is placed below all
// timeline content, so stopping above its title still reaches every message.
function lifelineEnd() {
  const legend = measureLegend(legendEntries(), legendLayout());
  return legend?.titleY == null ? layout.lifelineBottom : Math.min(layout.lifelineBottom, legend.titleY - 22);
}

// data-seq-from / data-seq-to / data-seq-y tell the viewer which parts move
// down or stretch when the reader opens a step's details (see stepDetailMarkup).
function renderLifeline(participant, end) {
  return `        <path data-seq-from="${layout.lifelineTop}" data-seq-to="${end}" d="M ${participant.cx} ${layout.lifelineTop} L ${participant.cx} ${end}" class="a-default" stroke-width="0.8" stroke-dasharray="3,7"/>`;
}

function renderSegment(segment, index) {
  return `        <rect data-seq-from="${segment.from}" data-seq-to="${segment.to}" data-graph-role="structural-frame" data-composition-frame-kind="segment" data-composition-frame-id="${index}" x="48" y="${segment.from}" width="${viewBox[0] - 96}" height="${segment.to - segment.from}" rx="10" class="c-lane" stroke-width="1"/>`;
}

function renderSegmentLabel(segment, index) {
  const label = segmentLabelBox(segment);
  return `        <g data-seq-y="${segment.from}" data-graph-role="segment-label" data-segment-id="${index}">
          <rect x="${label.x}" y="${label.y}" width="${label.width}" height="${label.height}" rx="3" class="c-mask"/>
          <text x="${label.x + 6}" y="${label.y + 13}" class="t-muted" font-size="${SEGMENT_FONT_SIZE}" font-weight="600">${esc(segment.label)}</text>
        </g>`;
}

function renderActivation(activation) {
  const participant = participants.get(activation.participant);
  const fill = componentFill[activation.type] || componentFill[participant.type] || 'c-external';
  const x = participant.cx - 5;
  const height = activation.to - activation.from;
  const span = `data-seq-from="${activation.from}" data-seq-to="${activation.to}"`;
  return `        <rect ${span} x="${x}" y="${activation.from}" width="10" height="${height}" rx="3" class="c-mask"/>
        <rect ${span} x="${x}" y="${activation.from}" width="10" height="${height}" rx="3" class="${fill}" stroke-width="1"/>`;
}

function messageLabel(message, x1, x2) {
  const box = messageLabelBox(message);
  const center = box ? box.x + box.width / 2 : (x1 + x2) / 2;
  const y = message.y - 10;
  const layoutW = box?.width || Math.max(34, textUnits(message.label) * messageUnitWidth + 12);
  const labelW = Math.min(layoutW, Math.max(34, textUnits(message.label) * messageFontSize * SANS_WIDTH_FACTOR + 8));
  // A colored line gets a label in the same color, as in the legend swatches.
  // Gray lines (default and return) keep the readable muted text color.
  const accent = ['emphasis', 'security', 'dashed'].includes(message.variant) ? edgeLabelAccent(message.variant) : 't-muted';
  // The thin halo keeps glyphs clear when an all-caps label runs past its plate.
  return `        <g data-detail="context">
          <rect x="${center - labelW / 2}" y="${y - 10}" width="${labelW}" height="${layout.labelH}" rx="3" class="c-mask"/>
          <text x="${center}" y="${y}" class="${accent}" font-size="${messageFontSize}" text-anchor="middle" paint-order="stroke" stroke-width="3" stroke-linejoin="round" style="stroke: var(--mask)">${esc(message.label)}</text>
        </g>`;
}

function noteBackdrop(message) {
  const note = noteRect(message);
  if (!note) return '';
  const box = { x: note.x - 2, y: note.y - 2, width: note.width + 4, height: note.height + 4 };
  const crossed = asArray(sequence.segments).some((segment) => [segment.from, segment.to]
    .some((border) => border >= box.y && border <= box.y + box.height));
  if (!crossed) return '';
  // The backdrop clears decorative frames, never another message. Standard
  // quality can retain overlapping annotations that showcase rejects.
  const coversMessage = asArray(sequence.messages).some((other) => other !== message
    && [messageLabelBox(other), messageRouteBox(other), noteRect(other)]
      .some((rect) => rect && rectsOverlap(box, rect, 0)));
  if (coversMessage) return '';
  return `\n        <rect data-detail="context" data-graph-role="message-note-background" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="2" class="c-mask" pointer-events="none"/>`;
}

function renderMessage(message, index) {
  const { start, end } = messageGeometry(message);
  const [cls, marker] = arrowClass[message.variant || 'default'] || arrowClass.default;
  const strokeWidth = message.variant === 'emphasis' ? 1.8 : 1.4;
  const dash = message.variant === 'return' ? ' stroke-dasharray="3,5"' : '';
  const noteBox = noteLayout(message);
  const noteContent = noteBox?.lines.length > 1
    ? noteBox.lines.map((line, lineIndex) => `<tspan x="${noteBox.x}" dy="${lineIndex ? NOTE_LINE_HEIGHT : 0}">${esc(line)}</tspan>`).join('')
    : esc(message.note);
  // Notes carry message conditions and already reserve timeline space. Keep
  // them readable at the default depth; Map still hides context without reflow.
  const note = noteBox
    ? `\n        <text data-detail="context" x="${noteBox.x}" y="${noteBox.baseline}" class="t-note" font-size="${NOTE_FONT_SIZE}">${noteContent}</text>`
    : '';
  return `        <g data-seq-y="${message.y}" ${focusEdgeAttrs(message.from, message.to, message.label, index, message.id)}>
          <path data-composition-edge-from="${esc(message.from)}" data-composition-edge-to="${esc(message.to)}"${message.id ? ` data-composition-edge-id="${esc(message.id)}"` : ''} data-composition-points="${routePointsValue([[start, message.y], [end, message.y]])}" d="M ${start} ${message.y} L ${end} ${message.y}" class="${cls}"${animateAttr(sequence.meta, 'edge', index)} stroke-width="${strokeWidth}"${dash} marker-end="url(#${marker})"/>
${messageLabel(message, start, end)}${noteBackdrop(message)}${note}
        </g>`;
}


// Blocks: one tinted band behind the adjacent participants of one app,
// service, firmware or hardware part, from the block title down to the
// lifeline end. Blocks run left to right in GROUP_LAYER_ORDER.
const GROUP_LAYER_ORDER = ['ui', 'app', 'service', 'firmware', 'hardware'];
const GROUP_PADDING = 3;
const GROUP_TITLE_HEIGHT = 20;
const GROUP_TITLE_FONT_SIZE = blockMode ? BLOCK_TEXT.groupTitle : 9;
const groups = asArray(sequence.groups);

function groupBox(group) {
  const members = asArray(group.participants).map((id) => participants.get(id)).filter(Boolean);
  if (!members.length) return null;
  const left = Math.min(...members.map((member) => member.x)) - GROUP_PADDING;
  const right = Math.max(...members.map((member) => member.x + member.width)) + GROUP_PADDING;
  return { left, right, top: layout.topY - GROUP_TITLE_HEIGHT };
}

function renderGroup(group, end) {
  const box = groupBox(group);
  if (!box) return '';
  const bottom = end + 8;
  return `        <g data-seq-group="${esc(group.id)}">
          <rect data-seq-from="${box.top}" data-seq-to="${bottom}" x="${box.left}" y="${box.top}" width="${box.right - box.left}" height="${bottom - box.top}" rx="8" class="seq-group" data-layer="${esc(group.layer)}"/>
          <text x="${box.left + 8}" y="${box.top + 14}" class="seq-group-title" data-layer="${esc(group.layer)}" font-size="${GROUP_TITLE_FONT_SIZE}" font-weight="600">${esc(group.label)}</text>
        </g>`;
}

// Steps: when a diagram has blocks or detail steps, every top-level message
// gets its number on the left rail. A step with details also gets a round
// toggle on the lifeline it calls; opening it shows the detail steps right
// below the step and moves the rest of the diagram down.
const STEP_RAIL_X = 20;
const DETAIL_ROW_TOP = 10;
const DETAIL_LABEL_RISE = 24;
const DETAIL_SELF_LOOP_WIDTH = 22;
const stepsNumbered = groups.length > 0
  || asArray(sequence.messages).some((message) => asArray(message.details).length);

function messageVariantStyle(variant) {
  const [cls, marker] = arrowClass[variant || 'default'] || arrowClass.default;
  return {
    cls,
    marker,
    strokeWidth: variant === 'emphasis' ? 1.8 : 1.4,
    dash: variant === 'return' ? ' stroke-dasharray="3,5"' : '',
    accent: ['emphasis', 'security', 'dashed'].includes(variant) ? edgeLabelAccent(variant) : 't-muted',
  };
}

function haloText(x, y, anchor, cls, text) {
  return `<text x="${x}" y="${y}" class="${cls}" font-size="${messageFontSize}" text-anchor="${anchor}" paint-order="stroke" stroke-width="3" stroke-linejoin="round" style="stroke: var(--mask)">${esc(text)}</text>`;
}

function noteMarkup(x, baseline, lines) {
  if (!lines.length) return '';
  const content = lines.map((line, index) => `<tspan x="${x}" dy="${index ? NOTE_LINE_HEIGHT : 0}">${esc(line)}</tspan>`).join('');
  return `<text x="${x}" y="${baseline}" class="t-note" font-size="${NOTE_FONT_SIZE}">${content}</text>`;
}

// Splits a label into two lines at the space nearest its middle, or else at
// the camelCase boundary nearest its middle (getController / PublicHash).
function splitLabel(label) {
  const text = String(label);
  const spaces = [];
  const humps = [];
  for (let index = 1; index < text.length; index += 1) {
    if (text[index - 1] === ' ') spaces.push(index);
    else if (/[a-z0-9]/.test(text[index - 1]) && /[A-Z]/.test(text[index])) humps.push(index);
  }
  const cuts = spaces.length ? spaces : humps;
  if (!cuts.length) return [text];
  const middle = text.length / 2;
  const cut = cuts.reduce((best, index) => (Math.abs(index - middle) < Math.abs(best - middle) ? index : best));
  return [text.slice(0, cut).trimEnd(), text.slice(cut)];
}

const DETAIL_LABEL_LINE_HEIGHT = Math.round(messageFontSize * 1.25);

// Where a step's detail block starts: below the step's arrow and note.
function stepDetailBase(message) {
  const note = noteLayout(message);
  return Math.max(message.y + 22, note ? note.bottom + 8 : 0);
}

// Builds the detail block of one step at its collapsed position. Returns the
// markup, its start y and its height; the viewer inserts the markup when the
// reader opens the step.
function stepDetailLayout(message, index) {
  const details = asArray(message.details);
  if (!details.length) return null;
  const base = stepDetailBase(message);
  const rows = [];
  const problems = [];
  let cursor = base + DETAIL_ROW_TOP;
  details.forEach((detail, detailIndex) => {
    const from = participants.get(detail.from);
    const to = participants.get(detail.to);
    if (!from || !to) return;
    const style = messageVariantStyle(detail.variant);
    const labelTextWidth = (text) => textUnits(text) * messageFontSize * SANS_WIDTH_FACTOR + 8;
    // A call label wider than the room between its two lifelines' bars takes
    // two lines, so it does not cover them.
    const room = Math.abs(to.cx - from.cx) - 2 * LABEL_BAR_CLEARANCE;
    const labelLines = from.id !== to.id && labelTextWidth(detail.label) > room ? splitLabel(detail.label) : [detail.label];
    const extraRise = (labelLines.length - 1) * DETAIL_LABEL_LINE_HEIGHT;
    const arrowY = cursor + DETAIL_LABEL_RISE + extraRise;
    const labelWidth = Math.max(...labelLines.map(labelTextWidth));
    const parts = [];
    let noteX;
    let noteWidth;
    let noteBaseline;
    if (from.id === to.id) {
      const x = from.cx + 6;
      const loopEnd = x + DETAIL_SELF_LOOP_WIDTH;
      parts.push(`<path d="M ${x} ${arrowY - 7} H ${loopEnd} V ${arrowY + 7} H ${x + 2}" class="${style.cls}" fill="none" stroke-width="${style.strokeWidth}"${style.dash} marker-end="url(#${style.marker})"/>`);
      const labelX = loopEnd + 8;
      parts.push(`<rect x="${labelX - 4}" y="${arrowY - 9}" width="${labelWidth}" height="${layout.labelH}" rx="3" class="c-mask"/>`);
      parts.push(haloText(labelX, arrowY + 4, 'start', style.accent, detail.label));
      const next = [...participants.values()].find((participant) => participant.index === from.index + 1);
      noteX = labelX;
      // Keep extra air before the next lifeline: the self-call note starts
      // past the loop, so its line is short and wraps by the word.
      noteWidth = Math.max(80, (next ? next.cx : viewBox[0] - 40) - NOTE_LIFELINE_CLEARANCE - 8 - noteX);
      noteBaseline = arrowY + 20;
      if (labelX - 4 + labelWidth > viewBox[0] - 8) {
        problems.push(`Detail step "${detail.label}" of message "${message.label}" calls "${from.id}" itself and its label runs past the canvas edge — shorten the label.`);
      }
    } else {
      const direction = to.cx > from.cx ? 1 : -1;
      const start = from.cx + direction * 7;
      const end = to.cx - direction * 7;
      const center = (start + end) / 2;
      parts.push(`<path d="M ${start} ${arrowY} L ${end} ${arrowY}" class="${style.cls}" stroke-width="${style.strokeWidth}"${style.dash} marker-end="url(#${style.marker})"/>`);
      parts.push(`<rect x="${center - labelWidth / 2}" y="${arrowY - 20 - extraRise}" width="${labelWidth}" height="${layout.labelH + extraRise}" rx="3" class="c-mask"/>`);
      labelLines.forEach((line, lineIndex) => {
        const lineY = arrowY - 10 - (labelLines.length - 1 - lineIndex) * DETAIL_LABEL_LINE_HEIGHT;
        parts.push(haloText(center, lineY, 'middle', style.accent, line));
      });
      const gap = noteGapIndex(from.index, to.index);
      noteX = participantX(gap) + NOTE_ARROW_INSET + NOTE_TEXT_INSET;
      noteWidth = Math.max(1, participantX(gap + 1) - NOTE_LIFELINE_CLEARANCE - noteX);
      noteBaseline = arrowY + 18;
    }
    const noteLines = detail.note ? wrapNoteText(detail.note, noteWidth) : [];
    parts.push(noteMarkup(noteX, noteBaseline, noteLines));
    parts.push(`<text x="${STEP_RAIL_X}" y="${arrowY + 3}" class="seq-step-number" font-size="${blockMode ? BLOCK_TEXT.step : 8}" text-anchor="middle">${index + 1}.${detailIndex + 1}</text>`);
    rows.push(`          <g data-seq-detail-row="${index + 1}.${detailIndex + 1}">${parts.join('')}</g>`);
    const rowBottom = noteLines.length
      ? noteBaseline + (noteLines.length - 1) * NOTE_LINE_HEIGHT + 4
      : arrowY + (from.id === to.id ? 10 : 6);
    cursor = rowBottom + 6;
  });
  const height = cursor + 6 - base;
  const band = `<rect x="34" y="${base}" width="${viewBox[0] - 68}" height="${height}" rx="6" class="seq-detail-band"/>`;
  return { base, height, markup: [band, ...rows].join('\n'), problems };
}

function renderStepMarks(message, index) {
  if (!stepsNumbered) return '';
  const detail = stepDetailLayout(message, index);
  const toggleAttrs = detail
    ? ` data-seq-detail-toggle="${index}" role="button" tabindex="0" aria-expanded="false" aria-label="${esc(`Step ${index + 1}: show details`)}"`
    : '';
  const badge = `          <g class="seq-step-badge${detail ? ' seq-step-toggle' : ''}"${toggleAttrs}>
            <circle cx="${STEP_RAIL_X}" cy="${message.y}" r="${blockMode ? 9.5 : 8}"/>
            <text x="${STEP_RAIL_X}" y="${message.y + 3.5}" font-size="${blockMode ? BLOCK_TEXT.step : 8.5}" font-weight="700" text-anchor="middle">${index + 1}</text>
          </g>`;
  if (!detail) return `        <g data-seq-y="${message.y}">\n${badge}\n        </g>`;
  const target = participants.get(message.to);
  const lifelineToggle = `          <g class="seq-step-toggle seq-lifeline-toggle"${toggleAttrs}>
            <circle cx="${target.cx}" cy="${message.y + 13}" r="7"/>
            <path class="seq-toggle-sign" d="M ${target.cx - 3.5} ${message.y + 13} H ${target.cx + 3.5}"/>
            <path class="seq-toggle-sign seq-toggle-plus" d="M ${target.cx} ${message.y + 9.5} V ${message.y + 16.5}"/>
          </g>`;
  const source = `          <g data-seq-detail-source="${index}" data-seq-base="${detail.base}" data-seq-height="${detail.height}" data-seq-markup="${esc(detail.markup)}"/>`;
  return `        <g data-seq-y="${message.y}">\n${badge}\n${lifelineToggle}\n${source}\n        </g>`;
}

function groupProblems() {
  const problems = [];
  const seen = new Map();
  const ordered = [];
  groups.forEach((group, groupIndex) => {
    const indexes = [];
    for (const id of asArray(group.participants)) {
      const participant = participants.get(id);
      if (!participant) {
        problems.push(`Block "${group.id}" lists unknown participant "${id}" (/groups/${groupIndex}/participants).`);
        continue;
      }
      if (seen.has(id)) problems.push(`Participant "${id}" is in both block "${seen.get(id)}" and block "${group.id}" — keep each participant in one block.`);
      seen.set(id, group.id);
      indexes.push(participant.index);
    }
    if (!indexes.length) return;
    indexes.sort((a, b) => a - b);
    if (indexes[indexes.length - 1] - indexes[0] !== indexes.length - 1) {
      problems.push(`Block "${group.id}" members are not next to each other — reorder participants so every member of "${group.label}" sits in adjacent columns.`);
    }
    ordered.push({ group, first: indexes[0] });
    const box = groupBox(group);
    const titleWidth = textUnits(group.label) * GROUP_TITLE_FONT_SIZE * SANS_WIDTH_FACTOR + 16;
    if (box && titleWidth > box.right - box.left) {
      problems.push(`Block title "${group.label}" (~${Math.round(titleWidth)}px) is wider than block "${group.id}" (${Math.round(box.right - box.left)}px) — shorten the title.`);
    }
  });
  ordered.sort((a, b) => a.first - b.first);
  let previous = null;
  for (const { group } of ordered) {
    const rank = GROUP_LAYER_ORDER.indexOf(group.layer);
    if (rank < 0) continue;
    if (previous && rank < GROUP_LAYER_ORDER.indexOf(previous.layer)) {
      problems.push(`Block "${group.label}" (${group.layer}) sits right of block "${previous.label}" (${previous.layer}) — order blocks left to right as ${GROUP_LAYER_ORDER.join(' → ')}.`);
    }
    previous = group;
  }
  asArray(sequence.messages).forEach((message, messageIndex) => {
    asArray(message.details).forEach((detail, detailIndex) => {
      for (const end of ['from', 'to']) {
        if (!participants.has(detail[end])) {
          problems.push(`Detail step "${detail.label}" (/messages/${messageIndex}/details/${detailIndex}/${end}) names unknown participant "${detail[end]}".`);
        }
      }
    });
    problems.push(...(stepDetailLayout(message, messageIndex)?.problems || []));
  });
  return problems;
}

function legendLayout() {
  return {
    x: 40,
    baselineY: layout.legendY,
    width: viewBox[0] - 80,
    // The same content-based budget as legendRequiredHeight(): a wrapped
    // legend may use any rows it needs as long as it stays below the content.
    minTitleY: Math.max(layout.lifelineTop, contentBottom + LEGEND_CONTENT_GAP),
    unfit: sequence.meta?.legend === undefined ? 'hide' : 'error',
    diagramType: 'sequence',
  };
}

function renderLegend() {
  return renderResolvedLegend({
    entries: legendEntries(),
    locale: sequence.meta.locale,
    layout: legendLayout(),
    renderSwatch: (entry) => `<path d="M ${entry.x} ${entry.baseline - 3} L ${entry.x + 34} ${entry.baseline - 3}" class="${entry.className}" stroke-width="${entry.strokeWidth || 1.4}"${entry.dash ? ` stroke-dasharray="${entry.dash}"` : ''} marker-end="url(#${entry.marker})"/>`,
  });
}

function renderSvg() {
  const participantList = [...participants.values()];
  // Same default-canvas contract as lifecycle: 920x760 is below the 1.55 wide
  // ratio, so without intrinsic-height the desktop Reader can neither narrow
  // nor scroll it and every default sequence fails the browser gate.
  const readerFit = sequence.meta?.viewBox ? '' : ' data-reader-fit="width-first"';
  const actualSize = blockMode ? ' data-seq-actual-size=""' : '';
  return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" data-sequence-column-fit="${columnFit}"${readerFit}${actualSize} ${svgRootAttrs(sequence.meta)} data-motion-choreography="sequence">
${svgAccessibleText(sequence.meta, 'sequence')}
${renderDefinitions()}

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Blocks -->
${groups.map((group) => renderGroup(group, lifelineEnd())).join('\n')}

        <!-- Time Segments -->
${asArray(sequence.segments).map(renderSegment).join('\n\n')}

        <!-- Lifelines -->
${participantList.map((participant) => renderLifeline(participant, lifelineEnd())).join('\n')}

        <!-- Activations -->
${asArray(sequence.activations).map(renderActivation).join('\n')}

        <!-- Messages -->
${asArray(sequence.messages).map(renderMessage).join('\n\n')}

        <!-- Step numbers and detail toggles -->
${asArray(sequence.messages).map(renderStepMarks).filter(Boolean).join('\n')}

        <!-- Segment Labels -->
${asArray(sequence.segments).map(renderSegmentLabel).join('\n')}

        <!-- Participants -->
${participantList.map(renderParticipant).join('\n\n')}

        <!-- Legend -->
        <g data-seq-y="${viewBox[1]}">
${renderLegend()}
        </g>
      </svg>`;
}

validateSequence();
writeDiagram({
  outPath,
  template,
  diagramType: 'sequence',
  meta: sequence.meta,
  svg: renderSvg(),
  cards: sequence.cards,
  sourceEvidence,
});
