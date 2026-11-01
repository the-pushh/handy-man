"use client";

/* Call a pro: what to tell them (ready to copy or share, photo and
   sound attached), then nearby pros for the verdict's trade from the
   backend's Places API (New) proxy. When that can't answer (no key on
   the server, Places error, no location, nothing found), a "Find nearby"
   button opens a Google Maps search for the trade instead. */

import { useEffect, useState } from "react";
import { sessionId } from "../lib/apiBase";

interface Pro {
  id: string;
  name: string;
  address: string;
  distance_km: number;
  open_now: boolean | null;
  phone: string | null;
  rating: number | null;
  ratings: number | null;
  maps_url: string | null;
}

export interface Brief {
  device: string;
  issue: string;
  finding: string;
  rule: string | null;
  checks: string[];
  sound: string | null;
  photo: File | null;
  clip: File | null;
}

export function briefText(b: Brief): string {
  return [
    `Item: ${b.device || "not identified"}`,
    `Problem: ${b.issue}`,
    `Finding: ${b.finding}`,
    b.rule ? `Why a pro: ${b.rule}` : "",
    b.checks.length ? `Already checked: ${b.checks.join("; ")}` : "",
    b.sound ? `Sound: ${b.sound}` : "",
    "Photo" + (b.clip ? " and sound clip" : "") + " attached.",
  ]
    .filter(Boolean)
    .join("\n");
}

/* What to type into Maps for each trade the rules layer can name. */
const MAPS_QUERY: Record<string, string> = {
  "two-wheeler mechanic": "two-wheeler mechanic",
  "inverter / battery service": "inverter battery service",
  "battery service": "battery service",
  "AC technician": "AC repair technician",
  "appliance technician": "appliance repair",
  "laptop / phone repair": "laptop phone repair",
  "gas technician": "gas stove repair",
};

/* A Maps search link. Only the trade goes in the URL, never a location:
   Maps resolves "near me" on the phone itself. */
export function mapsSearchURL(trade: string): string {
  const what = MAPS_QUERY[trade] || trade.replace(/\s*\/\s*/g, " ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${what} near me`)}`;
}

type State =
  | { kind: "locating" }
  | { kind: "loading" }
  | { kind: "ok"; pros: Pro[] }
  | { kind: "fallback"; text: string };

export default function CallAPro({ api, trade, brief }: { api: string; trade: string; brief: Brief }) {
  const [state, setState] = useState<State>({ kind: "locating" });

  useEffect(() => {
    const fallback = (text: string) => setState({ kind: "fallback", text });
    if (!navigator.geolocation) {
      fallback("Search Google Maps for one near you.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setState({ kind: "loading" });
        try {
          const r = await fetch(`${api}/api/pros`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session": sessionId() },
            // Location in the body, never in a URL.
            body: JSON.stringify({ trade, lat: pos.coords.latitude, lng: pos.coords.longitude }),
          });
          const d = await r.json();
          if (d.status === "ok" && d.pros.length) {
            setState({ kind: "ok", pros: d.pros });
          } else if (d.status === "ok") {
            fallback(`No ${trade} listed within 5 km. Search a wider area on Google Maps.`);
          } else if (d.status === "rate-limited") {
            fallback(`${d.detail} Meanwhile, search Google Maps.`);
          } else {
            // needs-places-key, places-error: same button, no error.
            fallback("Search Google Maps for one near you.");
          }
        } catch (_) {
          fallback("Search Google Maps for one near you.");
        }
      },
      () => fallback("Location is off here, so search Google Maps instead."),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, [api, trade]);

  return (
    <section className="call-pro">
      <BriefCard brief={brief} />

      <p className="sheet-label" style={{ marginTop: 16 }}>Nearby {trade}</p>
      {state.kind === "locating" && <p className="evidence-note">Finding where you are…</p>}
      {state.kind === "loading" && <p className="evidence-note">Searching nearby…</p>}
      {state.kind === "fallback" && (
        <div className="find-nearby">
          <p className="evidence-note">{state.text}</p>
          <a className="btn-primary" href={mapsSearchURL(trade)} target="_blank" rel="noreferrer">
            Find nearby {trade}
          </a>
        </div>
      )}
      {state.kind === "ok" && (
        <ol className="pro-list">
          {state.pros.map((p) => (
            <li key={p.id} className="pro-row">
              <div className="pro-main">
                <p className="pro-name">{p.name}</p>
                <p className="pro-meta">
                  {p.distance_km.toFixed(1)} km
                  {p.open_now === true && <span className="open"> · Open now</span>}
                  {p.open_now === false && <span className="closed"> · Closed</span>}
                  {p.rating ? ` · ★ ${p.rating.toFixed(1)}${p.ratings ? ` (${p.ratings})` : ""}` : ""}
                </p>
                <p className="pro-addr">{p.address}</p>
              </div>
              <div className="pro-actions">
                {p.phone ? (
                  <a className="btn-primary" href={`tel:${p.phone.replace(/\s+/g, "")}`}>Call</a>
                ) : (
                  <span className="evidence-note">No phone listed</span>
                )}
                {p.maps_url && (
                  <a className="btn-outline" href={p.maps_url} target="_blank" rel="noreferrer">Map</a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {state.kind === "ok" && <p className="evidence-note places-credit">Listings from Google Maps.</p>}
    </section>
  );
}

/* The "what to tell them" card: plain facts, photo and sound attached,
   Copy and Share. Used by call-a-pro and by History. */
export function BriefCard({ brief }: { brief: Brief }) {
  const [copied, setCopied] = useState(false);
  const [photoURL] = useState(() => (brief.photo ? URL.createObjectURL(brief.photo) : ""));
  const [clipURL] = useState(() => (brief.clip ? URL.createObjectURL(brief.clip) : ""));

  async function copy() {
    try {
      await navigator.clipboard.writeText(briefText(brief));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      setCopied(false);
    }
  }

  async function share() {
    const files = [brief.photo, brief.clip].filter(Boolean) as File[];
    const data: ShareData = { title: `${brief.device}: ${brief.finding}`, text: briefText(brief) };
    try {
      if (files.length && navigator.canShare?.({ files })) {
        await navigator.share({ ...data, files });
      } else {
        await navigator.share(data);
      }
    } catch (_) {
      await copy();
    }
  }

  return (
      <div className="brief-card">
        <p className="sheet-label">What to tell them</p>
        <table>
          <tbody>
            <tr><td>Item</td><td>{brief.device || "not identified"}</td></tr>
            <tr><td>Problem</td><td>{brief.issue}</td></tr>
            <tr><td>Finding</td><td>{brief.finding}</td></tr>
            {brief.rule && <tr><td>Why a pro</td><td>{brief.rule}</td></tr>}
            {brief.checks.length > 0 && (
              <tr>
                <td>Checked</td>
                <td>
                  <ul>{brief.checks.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </td>
              </tr>
            )}
            {brief.sound && <tr><td>Sound</td><td>{brief.sound}</td></tr>}
          </tbody>
        </table>
        <div className="brief-attach">
          {photoURL && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoURL} alt="photo of the item" />
          )}
          {clipURL && <audio controls src={clipURL} />}
        </div>
        <div className="brief-actions">
          <button type="button" className="btn-outline" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn-primary" onClick={() => void share()}>
            Share
          </button>
        </div>
      </div>
  );
}
