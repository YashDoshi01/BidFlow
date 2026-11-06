import { useEffect, useState } from 'react';
import { serverNow } from '../lib/clock.ts';
import { describeClock } from '../lib/countdown.ts';
import type { AuctionView } from '../room/roomState.ts';

/**
 * Only THIS component re-renders every second, not the page around it. The text is derived on each
 * tick from the auction's authoritative `endsAt` (which the server moves on anti-sniping
 * extensions) and an estimate of the server clock. The timer is a repaint trigger, not a clock:
 * if it were throttled in a background tab, the next tick still shows the right value.
 */
export function Countdown({
  auction,
  testId = 'countdown',
}: {
  auction: Pick<AuctionView, 'status' | 'startsAt' | 'endsAt' | 'endedAt'>;
  testId?: string;
}) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(serverNow());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  const clock = describeClock(
    auction,
    auction.status === 'LIVE' || auction.status === 'SCHEDULED' ? now : 0,
  );
  return (
    <div>
      <dt>{clock.label}</dt>
      <dd data-testid={testId} data-waiting={clock.waitingForServer ? 'true' : 'false'}>
        {clock.text}
      </dd>
    </div>
  );
}
