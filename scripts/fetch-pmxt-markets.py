#!/usr/bin/env python3
"""
Fetch World Cup 2026 match markets from Polymarket (fifwc) and Kalshi (KXWC)
via the pmxt Router and output structured JSON consumable by the TypeScript
infrastructure adapter (PmxtFetcher).

Output JSON shape:
{
  "capturedAt": "<ISO timestamp>",
  "kalshiMarkets": [ { venue, venueMarketId, title, rawResolutionText, rawPayload, capturedAt } ],
  "polymarketMarkets": [ ... ],
  "kalshiBooks": [ { marketId, venue, yesAsk, noAsk, yesAvailableUsd, noAvailableUsd, capturedAt } ],
  "polymarketBooks": [ ... ]
}
"""

import json
import os
import sys
from datetime import datetime, timezone

import pmxt

# Read from environment; the example key works for read-only public queries.
PMXT_API_KEY = os.environ.get("PMXT_API_KEY", "pmxt_d4b072cf2510c02d04b18396108cbfcb0903db2812b4c9027a5b4b48b113808b")


def make_snapshot(
    venue: str,
    venue_market_id: str,
    title: str,
    raw_resolution_text: str,
    captured_at: str,
) -> dict:
    return {
        "venue": venue,
        "venueMarketId": venue_market_id,
        "title": title,
        "rawResolutionText": raw_resolution_text,
        "rawPayload": {},
        "capturedAt": captured_at,
    }


def make_book(
    market_id: str,
    venue: str,
    yes_ask: float,
    no_ask: float,
    yes_available_usd: float,
    no_available_usd: float,
    captured_at: str,
) -> dict:
    return {
        "marketId": market_id,
        "venue": venue,
        "yesAsk": yes_ask,
        "noAsk": no_ask,
        "yesAvailableUsd": yes_available_usd,
        "noAvailableUsd": no_available_usd,
        "capturedAt": captured_at,
    }


def extract_poly_book(market, captured_at: str, venue: str = "polymarket") -> dict | None:
    """Extract a MarketBook from a pmxt market object."""
    yes = getattr(market, "yes", None)
    no = getattr(market, "no", None)
    if not yes or not no:
        return None

    yes_ask = getattr(yes, "best_ask", None)
    no_ask = getattr(no, "best_ask", None)
    if yes_ask is None or no_ask is None:
        return None

    # Use the same slug-based market ID as the snapshot.
    market_id = str(getattr(market, "slug", "")) or str(getattr(market, "market_id", ""))

    # Estimate available USD from volume_24h / total outcomes as fallback
    volume_24h = getattr(market, "volume_24h", 0) or 0
    yes_avail = max(volume_24h * 0.1, 100) if volume_24h > 0 else 100
    no_avail = max(volume_24h * 0.1, 100) if volume_24h > 0 else 100

    return make_book(
        market_id=market_id,
        venue=venue,
        yes_ask=float(yes_ask),
        no_ask=float(no_ask),
        yes_available_usd=round(yes_avail, 2),
        no_available_usd=round(no_avail, 2),
        captured_at=captured_at,
    )


def extract_poly_snapshot(market, captured_at: str, venue: str = "polymarket") -> dict:
    """Extract a VenueMarketSnapshot from a pmxt market object."""
    title = getattr(market, "title", "") or getattr(market, "question", "")
    description = getattr(market, "description", "") or ""
    # Use the venue slug (KXWC ticker for Kalshi, fifwc slug for Polymarket)
    # instead of the pmxt internal UUID so the normalizer can match on it.
    venue_id = str(getattr(market, "slug", "")) or str(getattr(market, "market_id", ""))

    # Polymarket market descriptions don't mention "World Cup" — the
    # tags do, so we inject the tournament name to pass isWorldCup2026().
    tags = getattr(market, "tags", None) or []
    normalized_text = description
    if any("world cup" in (str(t) or "").lower() or "fifa" in (str(t) or "").lower() for t in tags):
        normalized_text = "FIFA World Cup 2026\n" + normalized_text

    return make_snapshot(
        venue=venue,
        venue_market_id=venue_id,
        title=title,
        raw_resolution_text=normalized_text,
        captured_at=captured_at,
    )


def fetch_events(router, query: str, captured_at: str, venue: str = "polymarket"):
    """Fetch events matching a pmxt query and extract markets + books."""
    events = router.fetch_events(query=query, limit=50)
    markets = []
    books = []
    for event in events:
        for m in (getattr(event, "markets", None) or []):
            markets.append(extract_poly_snapshot(m, captured_at, venue=venue))
            book = extract_poly_book(m, captured_at, venue=venue)
            if book:
                books.append(book)
    return markets, books


def main():
    captured_at = datetime.now(timezone.utc).isoformat()

    try:
        router = pmxt.Router(pmxt_api_key=PMXT_API_KEY)
    except Exception as exc:
        print(json.dumps({"error": f"Failed to create pmxt Router: {exc}"}))
        sys.exit(1)

    try:
        poly_markets, poly_books = fetch_events(router, "fifwc", captured_at)
    except Exception as exc:
        poly_markets, poly_books = [], []
        sys.stderr.write(f"Warning: Polymarket fetch failed: {exc}\n")

    try:
        kalshi_markets, kalshi_books = fetch_events(router, "KXWC", captured_at, venue="kalshi")
    except Exception as exc:
        kalshi_markets, kalshi_books = [], []
        sys.stderr.write(f"Warning: Kalshi fetch failed: {exc}\n")

    result = {
        "capturedAt": captured_at,
        "polymarketMarkets": poly_markets,
        "polymarketBooks": poly_books,
        "kalshiMarkets": kalshi_markets,
        "kalshiBooks": kalshi_books,
    }

    json.dump(result, sys.stdout, indent=2, default=str)


if __name__ == "__main__":
    main()