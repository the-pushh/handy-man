import gsap from "gsap";

export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Pop-in for detection boxes (staggered, subtle). */
export function popIn(targets: gsap.TweenTarget): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    targets,
    { opacity: 0, scale: 0.7, y: 8 },
    {
      opacity: 1,
      scale: 1,
      y: 0,
      duration: 0.28,
      ease: "back.out(1.6)",
      stagger: 0.06,
      overwrite: true,
    }
  );
}

/** Rise-and-fade for panel blocks (causes, steps, caption, status). */
export function riseIn(el: Element | null): void {
  if (reducedMotion() || !el) return;
  gsap.fromTo(
    el,
    { opacity: 0, y: 14 },
    { opacity: 1, y: 0, duration: 0.3, ease: "power2.out", overwrite: true }
  );
}

/** Settle for the captured still landing over the live feed. */
export function stillIn(el: Element | null): void {
  if (reducedMotion() || !el) return;
  gsap.fromTo(
    el,
    { opacity: 0, scale: 1.03 },
    { opacity: 1, scale: 1, duration: 0.35, ease: "power2.out", overwrite: true }
  );
}
