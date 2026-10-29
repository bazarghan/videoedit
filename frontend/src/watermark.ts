import type { Edit, WatermarkTemplate, WatermarkText } from "./types";

export function templateFromLegacy(
  watermark: Edit["watermark"],
): WatermarkTemplate {
  const element: WatermarkText = {
    text: watermark.text,
    font_family: watermark.font,
    font_size: watermark.size,
    bold: false,
    color: watermark.color,
    opacity: watermark.opacity,
    alignment: "center",
  };
  return {
    rows: [[element]],
    gap_horizontal: 36,
    gap_vertical: 36,
    border_color: "#000000",
    border_thickness: 0,
    decay_time: 2,
    replication_count: 5,
    repeat: false,
  };
}

export function watermarkWindows(
  watermark: Edit["watermark"],
  template: WatermarkTemplate,
  duration: number,
): [number, number][] {
  const lower = Math.max(0, watermark.start);
  const upper =
    watermark.end === null ? duration : Math.min(duration, watermark.end);
  if (upper <= lower) return [];
  if (!template.repeat) return [[lower, upper]];
  const decay = template.decay_time;
  const count = template.replication_count;
  const stepping = Math.max(0, (upper - lower - decay * count) / count);
  const windows: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    const start = lower + stepping / 2 + index * (stepping + decay);
    const end = Math.min(upper, start + decay);
    if (start < upper && end > start) windows.push([start, end]);
  }
  return windows;
}

export function watermarkVisibleAt(
  watermark: Edit["watermark"],
  template: WatermarkTemplate | null,
  offset: number,
  duration: number,
): boolean {
  if (watermark.kind === "none") return false;
  if (!template || watermark.kind === "image") {
    return (
      offset >= watermark.start &&
      (watermark.end === null || offset <= watermark.end)
    );
  }
  return watermarkWindows(watermark, template, duration).some(
    ([start, end]) => offset >= start && offset <= end,
  );
}
