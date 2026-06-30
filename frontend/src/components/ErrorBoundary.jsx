import React from 'react';

export function ErrorFallback({ error, resetErrorBoundary }) {
  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] bg-[var(--charcoal, #1a1a1a)] text-white p-8">
      <div className="w-16 h-16 rounded-full border border-[var(--gold, #c9973a)] flex items-center justify-center mb-6 text-[var(--gold, #c9973a)] text-4xl font-display italic leading-none">
        त
      </div>
      <h2 className="text-2xl font-bold text-red-400 mb-4 tracking-wide">Something went wrong</h2>
      <pre className="text-sm bg-black/80 p-5 rounded-lg mb-8 max-w-2xl w-full whitespace-pre-wrap overflow-auto font-mono text-red-300 border border-red-500/20">
        {error?.message || "An unknown error occurred."}
      </pre>
      <button 
        onClick={() => resetErrorBoundary ? resetErrorBoundary() : window.location.reload()} 
        className="px-6 py-3 bg-amber-500 text-white rounded-lg font-bold hover:bg-amber-600 transition-colors"
      >
        Reload
      </button>
    </div>
  );
}

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
         const FallbackComponent = this.props.fallback;
         return <FallbackComponent error={this.state.error} resetErrorBoundary={this.resetErrorBoundary} />;
      }
      return <ErrorFallback error={this.state.error} resetErrorBoundary={this.resetErrorBoundary} />;
    }
    return this.props.children;
  }
}
