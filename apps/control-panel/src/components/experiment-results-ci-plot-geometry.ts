/**
 * The plot's fixed viewBox geometry, shared by the figure and its row marks so
 * the axis, the zero line and every whisker are laid out on one grid.
 */

export const PLOT_WIDTH = 560;
export const LABEL_WIDTH = 190;
export const VALUE_WIDTH = 130;
export const ROW_HEIGHT = 34;
export const AXIS_HEIGHT = 28;
export const TOP_PAD = 8;
export const VALUE_X = LABEL_WIDTH + PLOT_WIDTH + 8;

export function rowY(index: number): number {
  return TOP_PAD + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}
