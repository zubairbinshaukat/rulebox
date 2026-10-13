import { afterEach, describe, expect, it } from "vitest";
import gsap from "gsap";

import { enter, exit, type MotionLevel } from "./motion";

afterEach(() => {
  gsap.globalTimeline.clear();
});

function varsOf(tween: gsap.core.Tween): Record<string, unknown> {
  // GSAP stores the end values on the tween's vars.
  return tween.vars as Record<string, unknown>;
}

describe("motion helpers", () => {
  it("fade level only tweens autoAlpha on enter and exit", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const level: MotionLevel = "fade";

    const inTween = enter(el, level);
    const inVars = varsOf(inTween);
    expect(inVars.autoAlpha).toBe(1);
    expect(inVars.y).toBeUndefined();
    expect(inVars.duration).toBe(0.15);

    const outTween = exit(el, level);
    const outVars = varsOf(outTween);
    expect(outVars.autoAlpha).toBe(0);
    expect(outVars.y).toBeUndefined();
    expect(outVars.duration).toBe(0.15);

    el.remove();
  });

  it("full level tweens y and autoAlpha", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const inTween = enter(el, "full");
    expect(varsOf(inTween).y).toBe(0);
    expect(varsOf(inTween).autoAlpha).toBe(1);
    expect(varsOf(inTween).duration).toBe(0.2);

    const outTween = exit(el, "full");
    expect(varsOf(outTween).y).toBe(8);
    expect(varsOf(outTween).autoAlpha).toBe(0);

    el.remove();
  });
});
