import { Link, Route, Routes } from 'react-router';
import { CompetitorList } from './pages/CompetitorList';
import { CompetitorTimeline } from './pages/CompetitorTimeline';

export function App() {
  return (
    <div className="app">
      <header className="app-bar">
        <div className="container app-bar-inner">
          <Link to="/" className="brand">
            <PulseMark />
            <span>CompetitorPulse</span>
          </Link>
          <span className="app-bar-tagline">Competitor listings, tracked and explained</span>
        </div>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<CompetitorList />} />
          <Route path="/competitors/:id" element={<CompetitorTimeline />} />
          <Route
            path="*"
            element={
              <div className="card">
                <h2>Page not found</h2>
                <p className="muted">
                  <Link to="/">Back to the tracked competitors</Link>
                </p>
              </div>
            }
          />
        </Routes>
      </main>

      <footer className="container footer">
        <a href="https://github.com/IonutAng/competitor-pulse">Source on GitHub</a>
      </footer>
    </div>
  );
}

function PulseMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12h4l2.5-6.5 4 13 2.5-6.5H21" />
    </svg>
  );
}
