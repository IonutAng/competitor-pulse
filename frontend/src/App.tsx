import { Link, Route, Routes } from 'react-router';
import { CompetitorList } from './pages/CompetitorList';
import { CompetitorTimeline } from './pages/CompetitorTimeline';

export function App() {
  return (
    <div className="app">
      <header>
        <h1>
          <Link to="/">CompetitorPulse</Link>
        </h1>
        <p className="muted">Tracks competitor listings and explains what changed.</p>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<CompetitorList />} />
          <Route path="/competitors/:id" element={<CompetitorTimeline />} />
          <Route
            path="*"
            element={
              <p>
                Page not found. <Link to="/">Back to the list</Link>
              </p>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
