/**
 * The probe of the home page. The site check of the Pages workflow starts it in a browser at each width, before the
 * deploy. A failed check stops the deploy.
 *
 * The probe drives the detection lab. A preset, a situation and a slider each change the answer of the closed form, and
 * the switch shows the timeline as a table.
 *
 * The site check reads this TypeScript file directly. It removes the types and the `export` line, and it starts the
 * result as the body of an async function.
 */

// The site check gives these helpers to the probe.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];
declare const click: (target: string | Element) => void;

const LAB = '[aria-label="The detection lab"]';

const lede = (): string => $(`${LAB} .sy-lede`)?.textContent ?? "";
/** This function gives the value of a row of the readout. */
const readout = (label: string): string => $$(`${LAB} .sy-readout dt`).find((dt) => dt.textContent === label)?.nextElementSibling?.textContent ?? "";
/** This function gives the button of the lab with this text. */
const button = (label: string): Element | undefined => $$(`${LAB} button`).find((b) => b.textContent?.trim() === label);
/** This function tells if the button of the lab with this text is on. */
const pressed = (label: string): boolean => button(label)?.getAttribute("aria-pressed") === "true";

/** The lab hydrates when it comes into view, so the probe scrolls to it first. */
$(LAB)?.scrollIntoView();
check("the lab starts", await until(() => $(`${LAB}`)?.closest("astro-island")?.hasAttribute("ssr") === false), $(LAB)?.closest("astro-island")?.outerHTML.slice(0, 120));

// The first state is the cell Q1 of the harness.
check("the lab has the presets", ["Linux 6.6", "Cell Q1", "Cell Q3"].every((label) => button(label) !== undefined), $$(`${LAB} button`).length);
check("the first preset is on", pressed("Cell Q1"));
const first = readout("Closed form");
check("the lab gives a closed form", /\d/.test(first), first);
check("the lab draws the timeline", $$(`${LAB} svg`).length >= 2, $$(`${LAB} svg`).length);

// A preset gives another answer.
click(button("Linux 6.6") as Element);
check("a preset gives another closed form", await until(() => readout("Closed form") !== first), readout("Closed form"));
check("the lab marks no cell for Linux 6.6", !pressed("Cell Q1"));

// A situation gives another answer.
const idle = lede();
click(button("Frozen process") as Element);
check("a situation changes the answer", await until(() => lede() !== idle), lede());
check("the lab marks the situation", pressed("Frozen process"));

// A slider changes the answer. React reads the value through the setter of the prototype.
click(button("Cell Q1") as Element);
await until(() => pressed("Cell Q1"));
const before = readout("Closed form");
const slider = $$(`${LAB} input[type="range"]`).find((input) => input.closest("label")?.textContent?.includes("Keepalive idle time")) as HTMLInputElement | undefined;
check("the lab has the slider of the idle time", slider !== undefined);
if (slider !== undefined) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, String(Number(slider.value) + 20));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}
check("a slider changes the closed form", await until(() => readout("Closed form") !== before), readout("Closed form"));
check("a slider leaves the cell of the harness", !pressed("Cell Q1"));

// The switch shows the timeline as a table.
click(button("Table") as Element);
check("the switch shows the table", await until(() => $$(`${LAB} .sy-table tbody tr`).length >= 3), $$(`${LAB} .sy-table tbody tr`).length);
click(button("Chart") as Element);
check("the switch gives the chart again", await until(() => $(`${LAB} .sy-table`) === null && $$(`${LAB} svg`).length >= 2));

export {};
