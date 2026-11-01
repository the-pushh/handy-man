/* "no, it's an inverter" / "nahi, ye inverter hai" -> "inverter".
   Null when there is no device name to take (a bare "no"). */
export function correctionFrom(heard: string): string | null {
  const low = heard.toLowerCase().replace(/[.!?]/g, "").trim();
  const art = String.raw`(?:(?:an?|my|the|ek|mera|meri)\s+)?`;
  const tail = String.raw`(?:\s+(?:hai|he|h))?$`;
  const m =
    low.match(new RegExp(String.raw`(?:it'?s|it is|this is|that'?s|ye|yeh|yah)\s+` + art + "(.+?)" + tail)) ||
    low.match(new RegExp(String.raw`^(?:no|nahi|nahin|nope)[,\s]+` + art + "(.+?)" + tail));
  const name = m?.[1]?.trim() || "";
  if (!name || /^(?:no|not|wrong|nahi|nahin|it|this|that)$/.test(name)) return null;
  return name.split(/\s+/).slice(0, 4).join(" ");
}
