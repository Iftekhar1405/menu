"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import "lenis/dist/lenis.css";

/**
 * All scroll-driven motion on the landing page, in one place.
 *
 * There are three moments and nothing else:
 *   1. the hero settles in once, on load;
 *   2. the three problem lines light up as they are read;
 *   3. the step rail fills as you move through the five steps.
 * Everything else on the page is still. Scattered fade-ins on every block
 * are what make a page feel generated; these three each say something.
 *
 * Lenis smooths the scroll and drives ScrollTrigger from the same clock.
 * It only exists while this page is mounted — the dashboard has its own
 * scroll containers and drag-and-drop, which smooth scroll would fight.
 *
 * With `prefers-reduced-motion`, none of this runs: no smoothing, no
 * scrubbing, and the CSS shows every element in its finished state.
 */
export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".lp");
    if (!root) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) {
      root.classList.remove("is-motion");
      return;
    }
    root.classList.add("is-motion");

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({ anchors: { offset: -72 }, lerp: 0.11 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    const ctx = gsap.context(() => {
      // 1. Hero, once.
      gsap.fromTo(
        "[data-intro]",
        { opacity: 0, y: 28 },
        { opacity: 1, y: 0, duration: 1, ease: "power3.out", stagger: 0.09, delay: 0.05 },
      );

      // 2. Problem lines, read one at a time.
      gsap.utils.toArray<HTMLElement>(".lp-problem-line").forEach((line) => {
        gsap.fromTo(
          line,
          { opacity: 0.22 },
          {
            opacity: 1,
            ease: "none",
            scrollTrigger: { trigger: line, start: "top 82%", end: "top 52%", scrub: true },
          },
        );
      });

      // 3. The step rail.
      const steps = root.querySelector<HTMLElement>(".lp-steps");
      const fill = root.querySelector<HTMLElement>(".lp-steps-fill");
      if (steps && fill) {
        gsap.fromTo(
          fill,
          { scaleY: 0 },
          {
            scaleY: 1,
            ease: "none",
            scrollTrigger: { trigger: steps, start: "top 62%", end: "bottom 62%", scrub: true },
          },
        );
        steps.querySelectorAll<HTMLElement>(".lp-step").forEach((step) => {
          ScrollTrigger.create({
            trigger: step,
            start: "top 62%",
            onEnter: () => (step.dataset.active = "true"),
            onLeaveBack: () => (step.dataset.active = "false"),
          });
        });
      }
    }, root);

    // Someone switching reduced motion on mid-visit gets a still page.
    const onChange = () => {
      if (reduce.matches) {
        ctx.revert();
        lenis.destroy();
        root.classList.remove("is-motion");
      }
    };
    reduce.addEventListener("change", onChange);

    return () => {
      reduce.removeEventListener("change", onChange);
      ctx.revert();
      gsap.ticker.remove(tick);
      lenis.destroy();
      root.classList.remove("is-motion");
    };
  }, []);

  return null;
}

/**
 * Marks the page as animated before first paint, so the hero does not
 * flash in its final state and then jump back to animate. Kept in sync with
 * the check in `LandingMotion`. The CSS has a fail-safe that shows the
 * content anyway if the script never arrives.
 */
export const MOTION_BOOTSTRAP = `try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.currentScript.parentElement.classList.add('is-motion')}catch(e){}`;
