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
  const address = window.location.host;

  if (isError) {
    return (
      <div className="localpill off" title={`Mabari can't reach its server at ${address}`}>
        <i />
        Mabari server not reachable
      </div>
    );
  }
  return (
    <div className="localpill" title={`Running at ${address}, only on this computer`}>
      <i />
      Local
    </div>
  );
}
