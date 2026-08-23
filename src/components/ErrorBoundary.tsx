"use client";

import React from "react";

interface State {
  hasError: boolean;
  message: string | null;
}

/** Keeps a crashed page from white-screening the whole PWA — critical for a bedside device. */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, message: null };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unexpected error",
    };
  }

  componentDidCatch(error: unknown) {
    if (typeof console !== "undefined") console.error("[CareSpeak]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="card max-w-md w-full p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-xl font-bold text-[#1f1f1f] mb-2">Something went wrong</h1>
            <p className="text-sm text-[#6e6e6e] mb-6">{this.state.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="btn-primary px-6 py-3 text-sm"
            >
              Reload CareSpeak
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
