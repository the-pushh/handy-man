/* The walkthrough's analysis request (also the decide-ahead requests
   while the owner answers the last question). */

import { kb, mark } from "./timeline";
import { fetchJSON } from "./net";

export function requestDiagnosis(
  base: string,
  files: File[],
  text: string,
  perception: unknown,
  // Measured sound evidence (audiofeat summary), when the user recorded.
  sound = "",
  // The owner's replies to the first pass's questions; the server then
  // decides at higher effort and asks nothing more.
  answers = "",
  // Started before the owner tapped (one request per possible answer).
  ahead = false,
  // Rule id of a scan-time warning the owner chose to override: the
  // rules then keep every step (the verdict says it is their risk).
  acceptRisk = ""
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  mark("diagnosis sent", `${files.length} stills ${kb(files.reduce((n, f) => n + f.size, 0))}`);
  const fd = new FormData();
  fd.append("file", files[0], "still-0.jpg");
  files.slice(1).forEach((s, i) => fd.append("stills", s, `still-${i + 1}.jpg`));
  fd.append("text", text);
  // One still: reuse the first look's perception, go straight to
  // diagnosis. Extra views are perceived afresh.
  if (files.length === 1 && perception) {
    fd.append("perception", JSON.stringify(perception));
  }
  if (sound) fd.append("sound", sound);
  if (answers) fd.append("answers", answers);
  // The machine the owner named ("inverter"): beats a misread photo.
  const owner = (perception as { owner_says?: string } | null)?.owner_says;
  if (owner) fd.append("owner", owner);
  if (ahead) fd.append("ahead", "1");
  if (acceptRisk) fd.append("accept_risk", acceptRisk);
  // Never a frozen screen: give up after 60s and let the owner retry
  // (the server hedges slow calls well before this).
  return fetchJSON(`${base}/api/repair/analyze`, { method: "POST", body: fd }, {
    label: ahead ? "decide ahead" : answers ? "decide" : "diagnosis",
    timeoutMs: 60000,
  });
}
