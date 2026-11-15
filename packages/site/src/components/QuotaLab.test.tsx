import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import QuotaLab from "./QuotaLab.tsx";

const times = (html: string, pattern: RegExp): number => html.match(pattern)?.length ?? 0;

describe("the quota lab, as the server renders it", () => {
  const html = renderToString(<QuotaLab />);

  it("opens on the day of 25 hours in Chicago, with two takes at 01:30", () => {
    expect(html).toContain("2 of 4 used, 2 left");
    expect(html).toContain("Sun 1 Nov, 01:30 UTC−6");
    expect(html).toContain("25 h");
    expect(html).toContain('aria-pressed="true">Clocks go back</button>');
  });

  it("draws the window, the shift of the clock, the instant of the reader and the two counted takes", () => {
    expect(times(html, /class="sy-band"/g)).toBe(1);
    expect(html).toContain("02:00 → 01:00");
    expect(html).toMatch(/class="sy-now-text"[^>]*>01:30<\/text>/);
    // two dots on the strip, and one swatch in the legend
    expect(times(html, /class="sy-run"/g)).toBe(3);
    expect(times(html, /class="sy-refused"/g)).toBe(0);
    expect(html).toContain("Clock shift");
  });

  it("gives the shift a whole row of the readout on a phone, and no line breaks inside a shift", () => {
    expect(html).toMatch(/<div class="sy-readout-wide"><dt>Shift<\/dt><dd><span class="sy-readout-part">02:00 → 01:00<\/span><\/dd><\/div>/);
    expect(times(html, /class="sy-readout-wide"/g)).toBe(1);
  });

  it("names the window in the label of the chart, for a reader without the picture", () => {
    expect(html).toContain('aria-label="Room: 2 of 4 used, 2 left. The window runs from Sun 1 Nov, 00:00 UTC−5 to Mon 2 Nov, 00:00 UTC−6."');
  });

  it("can give back a unit, and has a table view", () => {
    expect(html).not.toMatch(/<button type="button" disabled="">Give 1 back/);
    expect(html).toContain(">Table</button>");
  });
});
