class RunCancelled(Exception):
    """Raised by the executor (or nodes) when the shared cancel_event is set.
    Caught by run_graph_worker to emit the 'cancelled' SSE event without being
    misreported as a regular run failure."""
    pass
