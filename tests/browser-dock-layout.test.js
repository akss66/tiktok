const {
  getDockedBrowserWidth,
  getDockedBrowserZoomFactor,
  normalizeBrowserDockMode,
} = require('../desktop/electron/browser-config');

describe('browser dock layout', () => {
  it('supports compact, balanced, and wide dock widths without covering the app workspace', () => {
    const windowWidth = 1832;
    const compact = getDockedBrowserWidth(windowWidth, 'compact');
    const balanced = getDockedBrowserWidth(windowWidth, 'balanced');
    const wide = getDockedBrowserWidth(windowWidth, 'wide');

    expect(compact).toBeLessThan(balanced);
    expect(balanced).toBeLessThan(wide);
    expect(windowWidth - wide).toBeGreaterThanOrEqual(720);
  });

  it('normalizes unknown modes and scales narrow browser content down', () => {
    expect(normalizeBrowserDockMode('unknown')).toBe('balanced');
    expect(getDockedBrowserZoomFactor(580)).toBe(0.82);
    expect(getDockedBrowserZoomFactor(760)).toBe(0.9);
    expect(getDockedBrowserZoomFactor(900)).toBe(1);
  });
});
