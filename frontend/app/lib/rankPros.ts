/* Which handyman to call first. Each listing gets a score from three
   things the owner cares about, in this order of weight:
     open now     +3 (closed -3, unknown 0)
     distance     -0.6 per km (5 km away costs as much as being closed)
     rating       (stars - 4) x 2, trusted in proportion to how many
                  people rated (full trust from 30 ratings); unrated -0.5
   The top three are shown first with the reasons; the rest follow. */

export interface Rankable {
  distance_km: number;
  open_now: boolean | null;
  rating: number | null;
  ratings: number | null;
}

export interface Ranked<T> {
  pro: T;
  score: number;
  why: string[];
}

export function rankPros<T extends Rankable>(pros: T[]): Ranked<T>[] {
  return pros
    .map((pro) => {
      const why: string[] = [];
      let score = 0;
      if (pro.open_now === true) {
        score += 3;
        why.push("open now");
      } else if (pro.open_now === false) {
        score -= 3;
        why.push("closed now");
      }
      score -= 0.6 * pro.distance_km;
      why.push(`${pro.distance_km.toFixed(1)} km`);
      if (pro.rating) {
        const trust = Math.min(1, (pro.ratings || 0) / 30);
        score += (pro.rating - 4) * 2 * trust;
        why.push(`★ ${pro.rating.toFixed(1)}${pro.ratings ? ` from ${pro.ratings}` : ""}`);
      } else {
        score -= 0.5;
        why.push("no ratings yet");
      }
      return { pro, score: Math.round(score * 100) / 100, why };
    })
    .sort((a, b) => b.score - a.score);
}

/* A wa.me link with the diagnosis card as the message. Only for numbers
   in international form (+91 ...): wa.me needs the country code, and
   guessing one could message a stranger. The owner presses send. */
export function whatsappURL(phone: string | null, text: string): string | null {
  if (!phone || !phone.trim().startsWith("+")) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
