import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

class GameErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="client-error-screen">
        <section>
          <h1>Kings of Glory could not start</h1>
          <p>
            Restart <code>npm run dev</code>, then refresh the page.
          </p>
          <p className="alert" role="alert">
            {this.state.error.message}
          </p>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <GameErrorBoundary>
    <App />
  </GameErrorBoundary>,
);
