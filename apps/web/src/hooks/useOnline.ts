import { useEffect, useState } from 'react';

/**
 * `navigator.onLine` is a hint, not proof: it says whether the device has a network
 * interface, not whether our server is reachable. A false value is reliable ("offline"); a
 * true value is not ("online" may still mean unreachable). The UI therefore uses it only
 * to explain a problem, never to decide whether to try.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = (): void => {
      setOnline(true);
    };
    const off = (): void => {
      setOnline(false);
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
