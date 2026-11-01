/* The walkthrough's analysis request. Shared so the first look can start
   it while the user is still confirming the device (the issue text and
   the still are already known), and the walkthrough picks it up. */

import { kb, mark } from "./timeline";

export function requestDiagnosis(
  base: string,
  files: File[],
  text: string,
  perception: unknown
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
  return fetch(`${base}/api/repair/analyze`, { method: "POST", body: fd }).then((r) => r.json());
}
