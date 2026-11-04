// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';

async function fetchHealth(): Promise<{ ok: boolean }> {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
  return response.json() as Promise<{ ok: boolean }>;
}

export function LocalStatus() {
  const { isError } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 5000,
    retry: false,
  });

  return (
    <div className={isError ? 'local off' : 'local'}>
      <i />
      <span>
        {isError ? 'Mabari server not reachable' : 'localhost:4317 · only on this computer'}
      </span>
    </div>
  );
}
