"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import "lenis/dist/lenis.css";

/**
 * All scroll-driven motion on the landing page, in one place.
 *
 * Each piece says something about the product rather than decorating it:
 *   - the hero settles in once, on load;
 *   - the receipt ribbon and the dish names run, faster while you scroll —
 *     a kitchen picking up pace;
 *   - the waiter's slips fall into order as you read "it's the system";
 *   - the step scenes change as each step reaches the middle of the screen;
 *   - the lamp over the last call switches on.
 * The printer loop and the cursor parallax live in HeroStage.
 *
 * Lenis smooths the scroll and drives ScrollTrigger from the same clock. It
 * only exists while this page is mounted — the dashboard has its own scroll
 * containers and drag-and-drop, which smooth scroll would fight.
 *
 * With `prefers-reduced-motion`, none of this runs, and the CSS shows every
 * element in a finished, still state.
 */
export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".lp");
    if (!root) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) {
      root.classList.remove("is-motion");
      showFirstScene(root);
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
      // Hero, once.
      gsap.fromTo(
        "[data-intro]",
        { opacity: 0, y: 32 },
        { opacity: 1, y: 0, duration: 1.1, ease: "power3.out", stagger: 0.09, delay: 0.05 },
      );

      // Marquees: a steady run, sped up by scroll velocity.
      const marquees = gsap.utils.toArray<HTMLElement>("[data-marquee]").map((el) => {
        const dir = Number(el.dataset.marquee) || -1;
        const seconds = Number(el.dataset.speed) || 60;
        return gsap.fromTo(
          el,
          { xPercent: dir < 0 ? 0 : -50 },
          { xPercent: dir < 0 ? -50 : 0, duration: seconds, ease: "none", repeat: -1 },
        );
      });
      let boost = 1;
      lenis.on("scroll", ({ velocity }: { velocity: number }) => {
        boost = 1 + Math.min(Math.abs(velocity) / 6, 5);
      });
      const easeBack = () => {
        boost += (1 - boost) * 0.06;
        for (const m of marquees) m.timeScale(boost);
      };
      gsap.ticker.add(easeBack);

      // The slips: from where they fell to a tidy stack.
      const slips = gsap.utils.toArray<HTMLElement>("[data-slip]");
      if (slips.length) {
        // Hand the pose the server rendered over to gsap.
        slips.forEach((s) => (s.style.transform = ""));
        const tl = gsap.timeline({
          scrollTrigger: { trigger: slips[0]!.parentElement, start: "top 75%", end: "top 15%", scrub: 0.8 },
        });
        slips.forEach((s) => {
          tl.fromTo(
            s,
            { x: Number(s.dataset.mx), y: Number(s.dataset.my), rotate: Number(s.dataset.mr) },
            { x: 0, y: 0, rotate: 0, ease: "power2.inOut" },
            0,
          );
        });
      }

      // Steps: the one nearest the middle of the screen is the one shown.
      const steps = gsap.utils.toArray<HTMLElement>("[data-step]");
      const scenes = gsap.utils.toArray<HTMLElement>("[data-scene]");
      const show = (i: number) => {
        steps.forEach((s, j) => (s.dataset.active = String(i === j)));
        scenes.forEach((s) => (s.dataset.show = String(Number(s.dataset.scene) === i)));
      };
      show(0);
      steps.forEach((step, i) => {
        ScrollTrigger.create({
          trigger: step,
          start: "top 55%",
          end: "bottom 55%",
          onToggle: (self) => self.isActive && show(i),
        });
      });

      // The lamp switches on: a flicker, then steady.
      const lamp = root.querySelector<HTMLElement>("[data-pendant]");
      if (lamp) {
        gsap
          .timeline({ scrollTrigger: { trigger: lamp, start: "top 70%", once: true } })
          .to(lamp, { opacity: 0.6, duration: 0.06 })
          .to(lamp, { opacity: 0.1, duration: 0.08 })
          .to(lamp, { opacity: 0.85, duration: 0.07 })
          .to(lamp, { opacity: 0.3, duration: 0.1 })
          .to(lamp, { opacity: 1, duration: 0.5, ease: "power2.out" });
      }

      return () => gsap.ticker.remove(easeBack);
    }, root);

    // Someone switching reduced motion on mid-visit gets a still page.
    const onChange = () => {
      if (reduce.matches) {
        ctx.revert();
        lenis.destroy();
        root.classList.remove("is-motion");
        showFirstScene(root);
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

/** Without scroll-driven scenes, the stage shows the first one and stays. */
function showFirstScene(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-scene]").forEach((s) => (s.dataset.show = String(s.dataset.scene === "0")));
}

/**
 * Marks the page as animated before first paint, so the hero does not
 * flash in its final state and then jump back to animate. Kept in sync with
 * the check in `LandingMotion`. The CSS has a fail-safe that shows the
 * content anyway if the script never arrives.
 */
export const MOTION_BOOTSTRAP = `try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.currentScript.parentElement.classList.add('is-motion')}catch(e){}`;
