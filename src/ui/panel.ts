// The collapsible settings panel: the transforms that are explicit choices
// rather than conducting gestures. Deliberately secondary — it starts closed,
// and nothing in it is needed to make the first sound.

export interface Setting {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  apply: (value: number) => void;
}

export class Panel {
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly outputs = new Map<string, HTMLOutputElement>();
  private readonly defaults = new Map<string, number>();

  constructor(
    private readonly grid: HTMLElement,
    private readonly settings: readonly Setting[],
  ) {
    for (const setting of settings) {
      this.defaults.set(setting.id, setting.value);
      grid.append(this.buildField(setting));
    }
  }

  private buildField(setting: Setting): HTMLElement {
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.htmlFor = `set-${setting.id}`;
    label.textContent = setting.label;

    const output = document.createElement("output");
    output.htmlFor = `set-${setting.id}`;
    output.textContent = setting.format(setting.value);

    const input = document.createElement("input");
    input.type = "range";
    input.id = `set-${setting.id}`;
    input.min = String(setting.min);
    input.max = String(setting.max);
    input.step = String(setting.step);
    input.value = String(setting.value);

    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.textContent = setting.format(value);
      setting.apply(value);
    });

    this.inputs.set(setting.id, input);
    this.outputs.set(setting.id, output);
    field.append(label, output, input);
    return field;
  }

  /**
   * Move a control from elsewhere (the conductor moves tempo) without re-firing
   * its apply, which would fight whatever set it. Called every frame while
   * conducting, so it does no DOM work when nothing has moved.
   */
  reflect(id: string, value: number): void {
    const input = this.inputs.get(id);
    if (!input || document.activeElement === input) return;
    if (Math.abs(Number(input.value) - value) < Number(input.step) / 2) return;
    input.value = String(value);
    const output = this.outputs.get(id);
    const setting = this.settings.find((candidate) => candidate.id === id);
    if (output && setting) output.textContent = setting.format(value);
  }

  read(id: string): number {
    return Number(this.inputs.get(id)?.value ?? 0);
  }

  set(id: string, value: number): void {
    const input = this.inputs.get(id);
    if (!input) return;
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  }

  /** Push every current value through its `apply`, so the engine agrees with
   *  what the panel is showing. */
  applyAll(): void {
    for (const setting of this.settings) setting.apply(this.read(setting.id));
  }

  resetAll(): void {
    for (const [id, value] of this.defaults) this.set(id, value);
  }
}
