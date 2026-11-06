// SPDX-License-Identifier: Apache-2.0

/**
 * What the page shows until the office arrives: a title and a few cards in the layout of the
 * pages, breathing quietly, so the first moment isn't a blank screen. It is announced as loading.
 */
export function ScreenSkeleton() {
  return (
    <section data-screen="loading" aria-busy="true" aria-label="Loading Mabari">
      <div className="page">
        <div className="skel title" />
        <div className="skeletons" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div className="card" key={index}>
              <div className="skel line" style={{ width: '48%' }} />
              <div className="skel line" style={{ width: '82%' }} />
              <div className="skel line" style={{ width: '64%' }} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
