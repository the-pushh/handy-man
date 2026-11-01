"use client";

/* Call a pro: what to tell them (ready to copy or share, photo and
   sound attached), then nearby pros for the verdict's trade from the
   backend's Places API (New) proxy. No manual-entry fallback. */

import { useEffect, useState } from "react";

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

type State =
  | { kind: "locating" }
  | { kind: "loading" }
  | { kind: "ok"; pros: Pro[] }
  | { kind: "message"; text: string };

export default function CallAPro({ api, trade, brief }: { api: string; trade: string; brief: Brief }) {
  const [state, setState] = useState<State>({ kind: "locating" });
  const [copied, setCopied] = useState(false);
  const [photoURL] = useState(() => (brief.photo ? URL.createObjectURL(brief.photo) : ""));
  const [clipURL] = useState(() => (brief.clip ? URL.createObjectURL(brief.clip) : ""));

  useEffect(() => {
    if (!navigator.geolocation) {
      setState({ kind: "message", text: "This browser can't share your location, so I can't search nearby." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setState({ kind: "loading" });
        try {
          const r = await fetch(`${api}/api/pros`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Location in the body, never in a URL.
            body: JSON.stringify({ trade, lat: pos.coords.latitude, lng: pos.coords.longitude }),
          });
          const d = await r.json();
          if (d.status === "ok") {
            setState(
              d.pros.length
                ? { kind: "ok", pros: d.pros }
                : { kind: "message", text: `No ${trade} found within 5 km.` }
            );
          } else if (d.status === "needs-places-key") {
            setState({ kind: "message", text: "Nearby search isn't set up on this server yet." });
          } else {
            setState({ kind: "message", text: "Couldn't reach the places search. Try again in a moment." });
          }
        } catch (_) {
          setState({ kind: "message", text: "Couldn't reach the server. Check the connection and try again." });
        }
      },
      () => setState({ kind: "message", text: "Location is off. Allow location to see pros near you." }),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, [api, trade]);

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
    <section className="call-pro">
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

      <p className="sheet-label" style={{ marginTop: 16 }}>Nearby {trade}</p>
      {state.kind === "locating" && <p className="evidence-note">Finding where you are…</p>}
      {state.kind === "loading" && <p className="evidence-note">Searching nearby…</p>}
      {state.kind === "message" && <p className="evidence-note">{state.text}</p>}
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
      <p className="evidence-note places-credit">Listings from Google Maps.</p>
    </section>
  );
}
