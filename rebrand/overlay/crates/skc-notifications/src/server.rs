//! Loopback WebSocket server for the notifications SDK.
//!
//! Owns the network surface: a per-session `ws://127.0.0.1:<port>` endpoint
//! with token auth, a connection registry, fan-out broadcast, replay of the
//! buffered ask to late clients, and reply routing into the [`ActionRegistry`].
//!
//! Lifecycle matches the planned N-API contract:
//! - [`start`] binds the loopback socket and returns the **bound** address
//!   before resolving; the accept loop runs in the background and is never
//!   awaited by the caller.
//! - [`ServerHandle::stop`] is idempotent: it cancels the accept loop and all
//!   per-connection tasks and may be called any number of times.

use std::{
	collections::HashMap,
	net::{IpAddr, Ipv4Addr, SocketAddr},
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::{
	net::{TcpListener, TcpStream},
	sync::{broadcast, mpsc, oneshot},
	time::sleep,
};
use tokio_tungstenite::tungstenite::{
	Message,
	handshake::server::{ErrorResponse, Request, Response},
	http::StatusCode,
};
use tokio_util::sync::CancellationToken;

use crate::{
	actions::{ActionIdentity, ActionRegistry, ClaimOutcome, ReplyOutcome},
	discovery::EndpointRecord,
	protocol::{
		ActionKind, ActionNeeded, ActionUnavailable, ActionUnavailableReason, AskSelectedAckCancel,
		AskSelectedAckCancelReason, AskSelectedAckFailedReason, AskSelectedAckOutcome,
		AskSelectedAckRequest, AskSelectedAckUnknownReason, ClientMessage, PROTOCOL_VERSION, Pong,
		RejectReason, ReplyAnswer, ReplyRejected, ServerHello, ServerMessage, SessionReady,
		capabilities,
	},
};

/// Configuration for a per-session notification server.
#[derive(Debug)]
pub struct ServerConfig {
	/// The session this endpoint belongs to.
	pub session_id:         String,
	/// The per-session token clients must present (as `?token=` on connect).
	pub token:              String,
	/// Bind host. Defaults to loopback via [`ServerConfig::new`].
	pub host:               IpAddr,
	/// Bind port. `0` selects an ephemeral port; the bound port is read back.
	pub port:               u16,
	/// Whether an unattended/RPC gate resolver is available for ask round-trips.
	/// When `false`, asks are notify-only and replies are rejected.
	pub resolver_available: bool,
	/// Optional SKC state root. When set, the server writes/removes the endpoint
	/// discovery file at `<state_root>/notifications/<session_id>.json`.
	pub state_root:         Option<PathBuf>,
	/// When `true`, accepted client replies are forwarded to the host (via
	/// [`ServerHandle::take_reply_receiver`]) instead of resolving internally,
	/// so the host resolves the real gate then calls
	/// [`ServerHandle::resolve_client`].
	pub forward_replies:    bool,
}

impl ServerConfig {
	/// Loopback config with an ephemeral port.
	#[must_use]
	pub fn new(session_id: impl Into<String>, token: impl Into<String>) -> Self {
		Self {
			session_id:         session_id.into(),
			token:              token.into(),
			host:               IpAddr::V4(Ipv4Addr::LOCALHOST),
			port:               0,
			resolver_available: true,
			state_root:         None,
			forward_replies:    false,
		}
	}
}

/// Bounded time a connection may defer controlled delivery while it advertises
/// its capabilities.
const CLIENT_HELLO_GRACE: Duration = Duration::from_secs(1);

/// Commands serialized through the owning connection task.
#[derive(Debug)]
enum DirectCommand {
	Deliver(Box<ServerMessage>, Option<oneshot::Sender<bool>>),
	ReevaluateAsk,
}

fn prepare_direct_ack(state: &ServerState, message: &ServerMessage) -> bool {
	let ServerMessage::AskSelectedAckRequest(request) = message else {
		return true;
	};
	state.acks.lock().begin_dispatch(request.request_id())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Negotiation {
	AwaitingHello,
	TimedOut,
	Negotiated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presentation {
	Unavailable,
	Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Delivered {
	identity:     ActionIdentity,
	presentation: Presentation,
}

#[derive(Debug, Clone)]
struct Connection {
	generation:   String,
	capabilities: Vec<String>,
	negotiation:  Negotiation,
	delivered:    Option<Delivered>,
	tx:           mpsc::UnboundedSender<DirectCommand>,
}

/// Error returned when a caller attempts to broadcast an action through the
/// generic frame API instead of the action lifecycle APIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushFrameError {
	ActionNeededProhibited,
}

impl std::fmt::Display for PushFrameError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::ActionNeededProhibited => {
				formatter.write_str("ActionNeeded must be sent with register_ask or note_idle")
			},
		}
	}
}

impl std::error::Error for PushFrameError {}

type AckOrigin = (String, String);
type FinishedAck = (String, Option<AckOrigin>, bool);

type AckFinish = (AskSelectedAckOutcome, Option<FinishedAck>);

#[derive(Debug)]
struct AckPending {
	commit_key: String,
	origin:     Option<AckOrigin>,
	dispatched: bool,
	waiter:     oneshot::Sender<AskSelectedAckOutcome>,
}

#[derive(Debug, Default)]
struct AckRegistry {
	pending:   HashMap<String, AckPending>,
	commits:   HashMap<String, String>,
	terminal:  HashMap<String, (AskSelectedAckOutcome, Instant)>,
	completed: HashMap<String, (String, AskSelectedAckOutcome, Instant)>,
}

impl AckRegistry {
	fn prune(&mut self) {
		self
			.terminal
			.retain(|_, (_, at)| at.elapsed() < Duration::from_mins(1));
		self
			.completed
			.retain(|_, (_, _, at)| at.elapsed() < Duration::from_mins(1));
	}

	fn finish(&mut self, request_id: &str, outcome: AskSelectedAckOutcome) -> AckFinish {
		let Some(pending) = self.pending.remove(request_id) else {
			let actual = self
				.completed
				.get(request_id)
				.map_or(outcome, |(_, outcome, _)| outcome.clone());
			return (actual, None);
		};
		self.commits.remove(&pending.commit_key);
		self
			.terminal
			.insert(pending.commit_key.clone(), (outcome.clone(), Instant::now()));
		self.completed.insert(
			request_id.to_owned(),
			(pending.commit_key.clone(), outcome.clone(), Instant::now()),
		);
		let finished = (pending.commit_key, pending.origin, pending.dispatched);
		let _ = pending.waiter.send(outcome.clone());
		(outcome, Some(finished))
	}

	fn cancel(
		&mut self,
		request_id: &str,
		commit_key: &str,
		outcome: AskSelectedAckOutcome,
	) -> AckFinish {
		if let Some((completed_commit, completed_outcome, _)) = self.completed.get(request_id) {
			return if completed_commit == commit_key {
				(completed_outcome.clone(), None)
			} else {
				(outcome, None)
			};
		}
		if self
			.pending
			.get(request_id)
			.is_none_or(|pending| pending.commit_key != commit_key)
		{
			return (outcome, None);
		}
		self.finish(request_id, outcome)
	}

	fn begin_dispatch(&mut self, request_id: &str) -> bool {
		let Some(pending) = self.pending.get_mut(request_id) else {
			return false;
		};
		pending.dispatched = true;
		true
	}

	fn settle_result(
		&mut self,
		connection_id: &str,
		generation: &str,
		result: &crate::protocol::AskSelectedAckResult,
	) -> bool {
		let authorized = self.pending.get(&result.request_id).is_some_and(|pending| {
			pending.commit_key == result.commit_key
				&& pending.origin.as_ref() == Some(&(connection_id.to_owned(), generation.to_owned()))
		});
		if !authorized {
			return false;
		}
		self
			.finish(&result.request_id, result.outcome.clone())
			.1
			.is_some()
	}

	fn finish_disconnect(&mut self, request_id: &str) {
		let Some(pending) = self.pending.get(request_id) else {
			return;
		};
		let outcome = if pending.dispatched {
			AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::OriginDisconnected }
		} else {
			AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::SessionClosed }
		};
		let _ = self.finish(request_id, outcome);
	}
}

#[derive(Debug)]
struct ServerState {
	token:              String,
	registry:           Mutex<ActionRegistry>,
	tx:                 broadcast::Sender<ServerMessage>,
	resolver_available: AtomicBool,
	/// Present in forward mode: accepted replies are sent here for the host.
	reply_tx:           Option<tokio::sync::mpsc::UnboundedSender<crate::actions::ClaimedReply>>,

	/// Always present: inbound free-text injections / in-thread config commands
	/// forwarded to the host (token-authorized).
	inbound_tx:  tokio::sync::mpsc::UnboundedSender<ClientMessage>,
	connections: Mutex<HashMap<String, Connection>>,
	acks:        Mutex<AckRegistry>,
	closing:     AtomicBool,

	/// Buffered last readiness frame, replayed to late-connecting clients so a
	/// lifecycle control client can wait for readiness deterministically.
	session_ready:       Mutex<Option<SessionReady>>,
	connection_sequence: AtomicU64,
}

/// Handle to a running server. Dropping it does not stop the server; call
/// [`ServerHandle::stop`] (idempotent) for deterministic shutdown.
#[derive(Debug, Clone)]
pub struct ServerHandle {
	addr:        SocketAddr,
	state:       Arc<ServerState>,
	cancel:      CancellationToken,
	accept_task: Arc<tokio::task::JoinHandle<()>>,
	session_id:  String,
	state_root:  Option<PathBuf>,
	reply_rx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<crate::actions::ClaimedReply>>>>,
	inbound_rx:  Arc<Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<ClientMessage>>>>,
}

impl ServerHandle {
	/// The bound socket address (with the real port when `0` was requested).
	#[must_use]
	pub const fn addr(&self) -> SocketAddr {
		self.addr
	}

	/// The `ws://host:port` URL clients connect to (token passed as `?token=`).
	#[must_use]
	pub fn url(&self) -> String {
		format!("ws://{}", self.addr)
	}

	/// Register an `ask` action and queue a connection-local reevaluation for
	/// every client. All asks use this path; only idle pings use broadcast.
	///
	/// `repliable` should be `true` only in unattended/RPC mode where the gate
	/// resolver can actually answer the ask.
	pub fn register_ask(&self, needed: ActionNeeded, repliable: bool) {
		self.state.registry.lock().register_ask(needed, repliable);
		let connections = self
			.state
			.connections
			.lock()
			.values()
			.map(|connection| connection.tx.clone())
			.collect::<Vec<_>>();
		for connection in connections {
			let _ = connection.send(DirectCommand::ReevaluateAsk);
		}
	}

	/// Broadcast an ephemeral idle ping (not buffered, not repliable).
	pub fn note_idle(&self, needed: ActionNeeded) {
		let msg = self.state.registry.lock().note_idle(needed);
		let _ = self.state.tx.send(ServerMessage::ActionNeeded(msg));
	}

	/// Broadcast an ephemeral threaded-session frame. `ActionNeeded` frames are
	/// prohibited here: use [`ServerHandle::register_ask`] or
	/// [`ServerHandle::note_idle`] so ask delivery remains connection-specific.
	///
	/// Like [`ServerHandle::note_idle`] these frames are not buffered for
	/// replay.
	///
	/// # Errors
	/// Returns [`PushFrameError::ActionNeededProhibited`] for `ActionNeeded`.
	pub fn push_frame(&self, msg: ServerMessage) -> Result<(), PushFrameError> {
		if matches!(msg, ServerMessage::ActionNeeded(_)) {
			return Err(PushFrameError::ActionNeededProhibited);
		}
		let _ = self.state.tx.send(msg);
		Ok(())
	}

	/// Publish a session-readiness signal: buffer it (so late-connecting clients
	/// see it on connect) and broadcast it to currently-connected clients.
	///
	/// Unlike [`ServerHandle::push_frame`], this frame is replayed on reconnect,
	/// so a lifecycle control client can wait for readiness deterministically
	/// instead of treating WS-open as readiness.
	pub fn push_session_ready(&self, ready: SessionReady) {
		*self.state.session_ready.lock() = Some(ready.clone());
		let _ = self.state.tx.send(ServerMessage::SessionReady(ready));
	}

	/// Resolve a pending action locally (e.g. the CLI/TUI answered it).
	///
	/// Broadcasts `action_resolved` so clients mark it non-repliable. A no-op if
	/// the action was already resolved.
	pub fn resolve_local(&self, id: &str, answer: Option<ReplyAnswer>) {
		let resolved = self.state.registry.lock().resolve_local(id, answer);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
		}
	}

	/// Take the receiver of accepted client replies (forward mode only).
	///
	/// Returns the receiver exactly once; subsequent calls return `None`. The
	/// host drains it, resolves the real gate per reply, then calls
	/// [`ServerHandle::resolve_client`] (or [`ServerHandle::reject`] on
	/// failure).
	#[must_use]
	pub fn take_reply_receiver(
		&self,
	) -> Option<tokio::sync::mpsc::UnboundedReceiver<crate::actions::ClaimedReply>> {
		self.reply_rx.lock().take()
	}

	/// Take the receiver of forwarded inbound messages (free-text injections and
	/// in-thread config commands). Returns the receiver exactly once; subsequent
	/// calls return `None`.
	#[must_use]
	pub fn take_inbound_receiver(
		&self,
	) -> Option<tokio::sync::mpsc::UnboundedReceiver<ClientMessage>> {
		self.inbound_rx.lock().take()
	}

	/// Resolve an unclaimed legacy action. Claimed forward-mode replies require
	/// [`Self::resolve_claim`] with the exact receipt.
	pub fn resolve_client(
		&self,
		id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> bool {
		let resolved = self
			.state
			.registry
			.lock()
			.resolve_client(id, answer, idempotency_key);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Resolve a claimed reply by its one-shot receipt and broadcast terminal
	/// state.
	pub fn resolve_claim(
		&self,
		receipt_id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> bool {
		let resolved = self
			.state
			.registry
			.lock()
			.resolve_claim(receipt_id, answer, idempotency_key);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Close an invalid claim terminally; callers must reissue under a fresh id.
	pub fn close_claim_invalid(&self, receipt_id: &str) -> bool {
		let resolved = self.state.registry.lock().close_claim_invalid(receipt_id);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Cancel an outstanding claim during abort or shutdown.
	pub fn cancel_claim(&self, receipt_id: &str) -> bool {
		let resolved = self.state.registry.lock().cancel_claim(receipt_id);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Reject only an unclaimed legacy reply. Claimed forward-mode replies must
	/// be closed by receipt so they cannot remain orphaned.
	pub fn reject(&self, id: &str, reason: RejectReason) -> bool {
		if self.state.registry.lock().has_claim_for_action(id) {
			return false;
		}
		let _ = self
			.state
			.tx
			.send(ServerMessage::ReplyRejected(ReplyRejected { id: id.to_owned(), reason }));
		true
	}

	/// Update whether the unattended gate resolver is currently available.
	pub fn set_resolver_available(&self, available: bool) {
		self
			.state
			.resolver_available
			.store(available, Ordering::SeqCst);
	}

	/// Unicast a live acknowledgement to the connection that atomically claimed
	/// the source reply, then await its one terminal correlated outcome.
	pub async fn request_ask_selected_ack(
		&self,
		receipt_id: &str,
		request: AskSelectedAckRequest,
	) -> AskSelectedAckOutcome {
		let action_id = match &request {
			AskSelectedAckRequest::Live { action_id, .. } => action_id,
			AskSelectedAckRequest::Recovery { .. } => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::Unsupported,
				};
			},
		};
		if self
			.state
			.registry
			.lock()
			.claim_action_id(receipt_id)
			.as_deref()
			!= Some(action_id)
		{
			return AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::RouteMissing };
		}
		let Some(origin) = self.state.registry.lock().claim_origin(receipt_id) else {
			return AskSelectedAckOutcome::Failed {
				reason: AskSelectedAckFailedReason::SessionClosed,
			};
		};
		match self.state.connections.lock().get(&origin.connection_id) {
			None => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::SessionClosed,
				};
			},
			Some(connection) if connection.generation != origin.generation => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::SessionClosed,
				};
			},
			Some(connection)
				if !connection
					.capabilities
					.iter()
					.any(|capability| capability == capabilities::ASK_SELECTED_ACK_V1) =>
			{
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::Unsupported,
				};
			},
			Some(_) => {},
		}
		self
			.request_ack(request, Some((origin.connection_id, origin.generation)))
			.await
	}

	/// Select exactly one authenticated acknowledgement-capable participant.
	pub async fn request_recovered_ask_selected_ack(
		&self,
		request: AskSelectedAckRequest,
	) -> AskSelectedAckOutcome {
		match &request {
			AskSelectedAckRequest::Recovery { session_id, .. } if session_id == &self.session_id => {},
			AskSelectedAckRequest::Recovery { .. } => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::RouteMissing,
				};
			},
			AskSelectedAckRequest::Live { .. } => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::Unsupported,
				};
			},
		}
		let participants: Vec<_> = self
			.state
			.connections
			.lock()
			.iter()
			.filter(|(_, c)| {
				c.capabilities
					.iter()
					.any(|v| v == capabilities::ASK_SELECTED_ACK_V1)
			})
			.map(|(id, c)| (id.clone(), c.generation.clone()))
			.collect();
		match participants.as_slice() {
			[] => AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::NoParticipant },
			[origin] => self.request_ack(request, Some(origin.clone())).await,
			_ => AskSelectedAckOutcome::Failed {
				reason: AskSelectedAckFailedReason::AmbiguousParticipant,
			},
		}
	}

	async fn request_ack(
		&self,
		request: AskSelectedAckRequest,
		origin: Option<(String, String)>,
	) -> AskSelectedAckOutcome {
		let request_id = request.request_id().to_owned();
		let commit_key = request.commit_key().to_owned();
		let deadline_at = request.deadline_at();
		let now_ms = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as i64;
		let remaining_ms = deadline_at.saturating_sub(now_ms);
		if remaining_ms <= 0 {
			return AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Expired };
		}
		let deadline =
			Duration::from_millis(u64::try_from(remaining_ms).unwrap_or_default().min(10_000));
		let (tx, rx) = oneshot::channel();
		{
			let mut acks = self.state.acks.lock();
			acks.prune();
			if self.state.closing.load(Ordering::Acquire) {
				return AskSelectedAckOutcome::Unknown {
					reason: AskSelectedAckUnknownReason::Shutdown,
				};
			}
			if let Some((outcome, _)) = acks.terminal.get(&commit_key) {
				return outcome.clone();
			}
			if acks.commits.contains_key(&commit_key) || acks.pending.contains_key(&request_id) {
				return AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Cancelled };
			}
			acks.commits.insert(commit_key.clone(), request_id.clone());
			acks.pending.insert(request_id.clone(), AckPending {
				commit_key,
				origin: origin.clone(),
				dispatched: false,
				waiter: tx,
			});
		}
		let (dispatch_tx, dispatch_rx) = oneshot::channel();
		let direct_tx = origin.as_ref().and_then(|(id, generation)| {
			self
				.state
				.connections
				.lock()
				.get(id)
				.filter(|connection| connection.generation == *generation)
				.map(|connection| connection.tx.clone())
		});
		let queued = direct_tx.is_some_and(|direct_tx| {
			direct_tx
				.send(DirectCommand::Deliver(
					Box::new(ServerMessage::AskSelectedAckRequest(request)),
					Some(dispatch_tx),
				))
				.is_ok()
		});
		if !queued {
			return self.finish_ack(
				&request_id,
				AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::SessionClosed },
				AskSelectedAckCancelReason::HostTimeout,
			);
		}
		match tokio::time::timeout(deadline, dispatch_rx).await {
			Ok(Ok(true)) => {},
			Ok(Ok(false) | Err(_)) => {
				return self.finish_ack(
					&request_id,
					AskSelectedAckOutcome::Unknown {
						reason: AskSelectedAckUnknownReason::TransportAmbiguous,
					},
					AskSelectedAckCancelReason::HostTimeout,
				);
			},
			Err(_) => {
				return self.finish_ack(
					&request_id,
					AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout },
					AskSelectedAckCancelReason::HostTimeout,
				);
			},
		}
		let now_ms = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as i64;
		let remaining_ms = deadline_at.saturating_sub(now_ms);
		if remaining_ms <= 0 {
			return self.finish_ack(
				&request_id,
				AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout },
				AskSelectedAckCancelReason::HostTimeout,
			);
		}
		match tokio::time::timeout(
			Duration::from_millis(u64::try_from(remaining_ms).unwrap_or_default().min(10_000)),
			rx,
		)
		.await
		{
			Ok(Ok(outcome)) => outcome,
			_ => self.finish_ack(
				&request_id,
				AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout },
				AskSelectedAckCancelReason::HostTimeout,
			),
		}
	}

	fn finish_ack(
		&self,
		request_id: &str,
		outcome: AskSelectedAckOutcome,
		cancel_reason: AskSelectedAckCancelReason,
	) -> AskSelectedAckOutcome {
		let (actual, cancel) = {
			let mut acks = self.state.acks.lock();
			let (actual, finished) = acks.finish(request_id, outcome);
			let cancel = finished.and_then(|(commit_key, origin, dispatched)| {
				dispatched.then_some((commit_key, origin))
			});
			(actual, cancel)
		};
		if let Some((commit_key, Some((id, generation)))) = cancel {
			let direct_tx = self
				.state
				.connections
				.lock()
				.get(&id)
				.filter(|connection| connection.generation == generation)
				.map(|connection| connection.tx.clone());
			if let Some(direct_tx) = direct_tx {
				let _ = direct_tx.send(DirectCommand::Deliver(
					Box::new(ServerMessage::AskSelectedAckCancel(AskSelectedAckCancel {
						request_id: request_id.to_owned(),
						commit_key,
						reason: cancel_reason,
					})),
					None,
				));
			}
		}
		actual
	}

	/// Terminalize a request and unicast the caller-provided cancellation frame
	/// only when the request was actually dispatched.
	pub fn cancel_ask_selected_ack(&self, cancel: AskSelectedAckCancel) -> AskSelectedAckOutcome {
		let outcome = AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Cancelled };
		let (actual, dispatched) = {
			let mut acks = self.state.acks.lock();
			let (actual, finished) = acks.cancel(&cancel.request_id, &cancel.commit_key, outcome);
			let dispatched = finished.and_then(|(_, origin, dispatched)| dispatched.then_some(origin));
			(actual, dispatched)
		};
		if let Some(Some((id, generation))) = dispatched {
			let direct_tx = self
				.state
				.connections
				.lock()
				.get(&id)
				.filter(|connection| connection.generation == generation)
				.map(|connection| connection.tx.clone());
			if let Some(direct_tx) = direct_tx {
				let _ = direct_tx.send(DirectCommand::Deliver(
					Box::new(ServerMessage::AskSelectedAckCancel(cancel)),
					None,
				));
			}
		}
		actual
	}

	/// Number of clients currently subscribed to the broadcast channel.
	#[must_use]
	pub fn client_count(&self) -> usize {
		self.state.tx.receiver_count()
	}

	/// Stop the server. Idempotent: cancels the accept loop and all connection
	/// tasks; safe to call multiple times.
	pub fn stop(&self) {
		self.state.closing.store(true, Ordering::Release);
		let ids: Vec<_> = self.state.acks.lock().pending.keys().cloned().collect();
		for id in ids {
			let _ = self.finish_ack(
				&id,
				AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::Shutdown },
				AskSelectedAckCancelReason::SessionShutdown,
			);
		}
		self.cancel.cancel();
		self.accept_task.abort();
		if let Some(root) = self.state_root.as_deref() {
			let _ = crate::discovery::remove_endpoint(root, &self.session_id);
		}
	}
}

impl Drop for ServerHandle {
	fn drop(&mut self) {
		if Arc::strong_count(&self.accept_task) == 1 {
			self.cancel.cancel();
		}
	}
}

/// Bind the loopback endpoint and spawn the accept loop in the background.
///
/// Resolves only after the socket is bound; the returned [`ServerHandle::addr`]
/// reflects the real (possibly ephemeral) port.
///
/// # Errors
/// Returns the bind error if the loopback socket cannot be acquired.
pub async fn start(config: ServerConfig) -> std::io::Result<ServerHandle> {
	let listener = TcpListener::bind(SocketAddr::new(config.host, config.port)).await?;
	let addr = listener.local_addr()?;
	let (tx, _rx) = broadcast::channel(256);

	if let Some(state_root) = config.state_root.as_deref() {
		let record = EndpointRecord::new(
			config.session_id.as_str(),
			&addr.ip().to_string(),
			addr.port(),
			config.token.as_str(),
		);
		crate::discovery::write_endpoint(state_root, &record)?;
	}

	let (reply_tx, reply_rx) = if config.forward_replies {
		let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
		(Some(tx), Some(rx))
	} else {
		(None, None)
	};
	let (inbound_tx, inbound_rx) = tokio::sync::mpsc::unbounded_channel::<ClientMessage>();

	let state = Arc::new(ServerState {
		token: config.token,
		registry: Mutex::new(ActionRegistry::new()),
		tx,
		resolver_available: AtomicBool::new(config.resolver_available),
		reply_tx,
		inbound_tx,
		connections: Mutex::new(HashMap::new()),
		acks: Mutex::new(AckRegistry::default()),
		closing: AtomicBool::new(false),

		session_ready: Mutex::new(None),
		connection_sequence: AtomicU64::new(1),
	});
	let cancel = CancellationToken::new();
	let accept_task = tokio::spawn(accept_loop(listener, Arc::clone(&state), cancel.clone()));
	Ok(ServerHandle {
		addr,
		state,
		cancel,
		accept_task: Arc::new(accept_task),
		session_id: config.session_id,
		state_root: config.state_root,
		reply_rx: Arc::new(Mutex::new(reply_rx)),
		inbound_rx: Arc::new(Mutex::new(Some(inbound_rx))),
	})
}

async fn accept_loop(listener: TcpListener, state: Arc<ServerState>, cancel: CancellationToken) {
	loop {
		tokio::select! {
			 () = cancel.cancelled() => break,
			 accepted = listener.accept() => {
				  let Ok((stream, _peer)) = accepted else { continue };
				  tokio::spawn(handle_conn(stream, Arc::clone(&state), cancel.clone()));
			 }
		}
	}
}

#[allow(
	clippy::result_large_err,
	reason = "ErrorResponse is the type mandated by tokio-tungstenite's accept_hdr_async callback"
)]
async fn handle_conn(stream: TcpStream, state: Arc<ServerState>, cancel: CancellationToken) {
	let expected = state.token.clone();
	let auth = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
		if token_from_query(req.uri().query()).is_some_and(|t| tokens_match(&t, &expected)) {
			Ok(resp)
		} else {
			let body = ErrorResponse::new(Some("unauthorized".to_owned()));
			let (mut parts, body) = body.into_parts();
			parts.status = StatusCode::UNAUTHORIZED;
			Err(ErrorResponse::from_parts(parts, body))
		}
	};

	let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, auth).await else {
		return;
	};
	let connection_id =
		format!("connection:{}", state.connection_sequence.fetch_add(1, Ordering::Relaxed));
	let generation = "0".to_owned();
	let (direct_tx, mut direct_rx) = mpsc::unbounded_channel::<DirectCommand>();

	let mut rx = state.tx.subscribe();
	let (mut write, mut read) = ws.split();
	let hello = ServerMessage::Hello(ServerHello {
		protocol_version: PROTOCOL_VERSION,
		capabilities:     vec![
			capabilities::THREADED.into(),
			capabilities::CONTEXT.into(),
			capabilities::TURN_STREAM.into(),
			capabilities::IMAGES.into(),
			capabilities::CONFIG.into(),
			capabilities::CLIENT_PING_PONG.into(),
			capabilities::SESSION_READY.into(),
			capabilities::ASK_CONTROLS_V1.into(),
			capabilities::ASK_SELECTED_ACK_V1.into(),
		],
	});
	if send_msg(&mut write, &hello).await.is_err() {
		return;
	}

	state
		.connections
		.lock()
		.insert(connection_id.clone(), Connection {
			generation:   generation.clone(),
			capabilities: Vec::new(),
			negotiation:  Negotiation::AwaitingHello,
			delivered:    None,
			tx:           direct_tx.clone(),
		});

	// Replay readiness before ask presentation; the ask itself is tailored by the
	// connection task after insertion and never written before ClientHello policy.
	let ready_replay = state.session_ready.lock().clone();
	if let Some(ready) = ready_replay
		&& send_msg(&mut write, &ServerMessage::SessionReady(ready))
			.await
			.is_err()
	{
		state.connections.lock().remove(&connection_id);
		return;
	}
	let _ = direct_tx.send(DirectCommand::ReevaluateAsk);

	let grace = sleep(CLIENT_HELLO_GRACE);
	tokio::pin!(grace);
	let mut awaiting = true;
	loop {
		tokio::select! {
			() = cancel.cancelled() => {
				while let Ok(direct) = direct_rx.try_recv() {
					if let DirectCommand::Deliver(message, dispatched) = direct {
						if !prepare_direct_ack(&state, &message) {
							if let Some(dispatched) = dispatched {
								let _ = dispatched.send(false);
							}
							continue;
						}
						let sent = send_msg(&mut write, &message).await.is_ok();
						if let Some(dispatched) = dispatched {
							let _ = dispatched.send(sent);
						}
						if !sent {
							break;
						}
					}
				}
				break;
			},
			() = &mut grace, if awaiting => {
				awaiting = false;
				if let Some(connection) = state.connections.lock().get_mut(&connection_id) {
					connection.negotiation = Negotiation::TimedOut;
				}
				let _ = direct_tx.send(DirectCommand::ReevaluateAsk);
			},
			incoming = read.next() => {
				match incoming {
					Some(Ok(Message::Text(text))) => {
						if !handle_text(
							text.as_str(),
							&state,
							&mut write,
							&connection_id,
							&generation,
							&mut awaiting,
							&direct_tx,
						).await {
							break;
						}
					},
					Some(Ok(Message::Ping(payload))) => {
						if write.send(Message::Pong(payload)).await.is_err() {
							break;
						}
					},
					Some(Ok(Message::Close(_))) | None => break,
					Some(Ok(_)) => {},
					Some(Err(_)) => break,
				}
			},
			direct = direct_rx.recv() => {
				let Some(direct) = direct else {
					break;
				};
				match direct {
					DirectCommand::Deliver(message, dispatched) => {
						if !prepare_direct_ack(&state, &message) {
							if let Some(dispatched) = dispatched {
								let _ = dispatched.send(false);
							}
							continue;
						}
						let sent = send_msg(&mut write, &message).await.is_ok();
						if let Some(dispatched) = dispatched {
							let _ = dispatched.send(sent);
						}
						if !sent {
							break;
						}
					},
					DirectCommand::ReevaluateAsk => {
						if !reevaluate_ask(&state, &mut write, &connection_id).await {
							break;
						}
					},
				}
			},
			broadcasted = rx.recv() => {
				match broadcasted {
					Ok(msg) => {
						let allowed = !matches!(
							&msg,
							ServerMessage::ActionNeeded(needed)
								if needed.kind != ActionKind::Idle || !needed.controls.is_empty()
						);
						if allowed && send_msg(&mut write, &msg).await.is_err() {
							break;
						}
					},
					Err(broadcast::error::RecvError::Lagged(_)) => {},
					Err(broadcast::error::RecvError::Closed) => break,
				}
			},
		}
	}
	state.connections.lock().remove(&connection_id);
	let ids: Vec<_> = state
		.acks
		.lock()
		.pending
		.iter()
		.filter(|(_, p)| p.origin.as_ref() == Some(&(connection_id.clone(), generation.clone())))
		.map(|(id, _)| id.clone())
		.collect();
	for id in ids {
		state.acks.lock().finish_disconnect(&id);
	}
}

/// Reevaluate the canonical ask inside the connection task so its write is
/// serialized with all broadcast and direct frames. The registry retains only
/// canonical action data; this constant-space record is presentation authority.
async fn reevaluate_ask<S>(state: &Arc<ServerState>, write: &mut S, connection_id: &str) -> bool
where
	S: SinkExt<Message> + Unpin,
{
	let Some((needed, identity)) = state.registry.lock().current_ask_snapshot() else {
		return true;
	};
	let Some((negotiation, client_capabilities, delivered)) = state
		.connections
		.lock()
		.get(connection_id)
		.map(|connection| {
			(connection.negotiation, connection.capabilities.clone(), connection.delivered.clone())
		})
	else {
		return false;
	};

	let presentation = if needed.controls.is_empty() {
		Some(Presentation::Full)
	} else {
		match negotiation {
			Negotiation::AwaitingHello => None,
			Negotiation::TimedOut => Some(Presentation::Unavailable),
			Negotiation::Negotiated
				if client_capabilities
					.iter()
					.any(|capability| capability == capabilities::ASK_CONTROLS_V1) =>
			{
				Some(Presentation::Full)
			},
			Negotiation::Negotiated => Some(Presentation::Unavailable),
		}
	};
	let Some(presentation) = presentation else {
		return true;
	};
	if delivered.as_ref().is_some_and(|delivered| {
		delivered.identity == identity
			&& (delivered.presentation == presentation || delivered.presentation == Presentation::Full)
	}) {
		return true;
	}

	// Confirm current identity immediately before the connection writer emits.
	if state.registry.lock().current_identity().as_ref() != Some(&identity) {
		return true;
	}
	let message = match presentation {
		Presentation::Full => ServerMessage::ActionNeeded(needed),
		Presentation::Unavailable => ServerMessage::ActionUnavailable(ActionUnavailable {
			id:                    needed.id,
			session_id:            needed.session_id,
			reason:                ActionUnavailableReason::MissingCapability,
			required_capabilities: vec![capabilities::ASK_CONTROLS_V1.into()],
		}),
	};
	if send_msg(write, &message).await.is_err() {
		return false;
	}
	if let Some(connection) = state.connections.lock().get_mut(connection_id) {
		connection.delivered = Some(Delivered { identity, presentation });
	}
	true
}

/// Returns `false` when the connection should close.
async fn handle_text<S>(
	text: &str,
	state: &Arc<ServerState>,
	write: &mut S,
	connection_id: &str,
	generation: &str,
	awaiting: &mut bool,
	direct_tx: &mpsc::UnboundedSender<DirectCommand>,
) -> bool
where
	S: SinkExt<Message> + Unpin,
{
	let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
		// Ignore malformed frames without tearing down the connection.
		return true;
	};
	let reply = match msg {
		ClientMessage::Reply(reply) => reply,
		// Inbound free-text injection / in-thread config command: forward to the
		// host (token-authorized) and stop. These are not action replies.
		ClientMessage::UserMessage(u) => {
			if tokens_match(&u.token, &state.token) {
				let _ = state.inbound_tx.send(ClientMessage::UserMessage(u));
			}
			return true;
		},
		ClientMessage::ConfigCommand(c) => {
			if tokens_match(&c.token, &state.token) {
				let _ = state.inbound_tx.send(ClientMessage::ConfigCommand(c));
			}
			return true;
		},
		ClientMessage::ControlCommand(c) => {
			if tokens_match(&c.token, &state.token) {
				let _ = state.inbound_tx.send(ClientMessage::ControlCommand(c));
			}
			return true;
		},
		ClientMessage::Ping(p) => {
			return send_msg(write, &ServerMessage::Pong(Pong { nonce: p.nonce }))
				.await
				.is_ok();
		},
		ClientMessage::AskSelectedAckResult(result) => {
			state
				.acks
				.lock()
				.settle_result(connection_id, generation, &result);
			return true;
		},
		ClientMessage::Hello(hello) => {
			*awaiting = false;
			if let Some(connection) = state.connections.lock().get_mut(connection_id) {
				for capability in hello.capabilities {
					if !connection.capabilities.contains(&capability) {
						connection.capabilities.push(capability);
					}
				}
				connection.negotiation = Negotiation::Negotiated;
			}
			let _ = direct_tx.send(DirectCommand::ReevaluateAsk);
			return true;
		},
		ClientMessage::Unknown => return true,
	};

	let authorized = tokens_match(&reply.token, &state.token);
	let resolver = state.resolver_available.load(Ordering::SeqCst);
	let delivered = state
		.connections
		.lock()
		.get(connection_id)
		.filter(|connection| connection.generation == generation)
		.and_then(|connection| match &connection.delivered {
			Some(Delivered { identity, presentation: Presentation::Full }) => Some(identity.clone()),
			_ => None,
		});

	// Forward mode: accepted replies go to the host, which must settle the exact
	// claim receipt after resolving the real gate.
	if let Some(reply_tx) = &state.reply_tx {
		let classification = state.registry.lock().claim_reply_if_delivered(
			delivered.as_ref(),
			&reply,
			connection_id,
			generation,
			authorized,
			resolver,
		);
		return match classification {
			ClaimOutcome::Forward(claim) => {
				let receipt_id = claim.reply_receipt_id.clone();
				if reply_tx.send(claim).is_err() {
					let resolved = state.registry.lock().cancel_claim(&receipt_id);
					if let Some(resolved) = resolved {
						let _ = state.tx.send(ServerMessage::ActionResolved(resolved));
					}
				}
				true
			},
			ClaimOutcome::Duplicate => true,
			ClaimOutcome::Reject(reason) => {
				send_msg(write, &ServerMessage::ReplyRejected(ReplyRejected { id: reply.id, reason }))
					.await
					.is_ok()
			},
		};
	}

	let outcome = state.registry.lock().apply_reply_if_delivered(
		delivered.as_ref(),
		&reply,
		authorized,
		resolver,
	);

	match outcome {
		ReplyOutcome::Resolved(resolved) => {
			// Broadcast so every client (including this one) marks it non-repliable.
			let _ = state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		},
		ReplyOutcome::DuplicateAccepted => true,
		ReplyOutcome::Rejected(reason) => {
			// Reply rejections go only to the offending client.
			send_msg(write, &ServerMessage::ReplyRejected(ReplyRejected { id: reply.id, reason }))
				.await
				.is_ok()
		},
	}
}

async fn send_msg<S>(write: &mut S, msg: &ServerMessage) -> Result<(), ()>
where
	S: SinkExt<Message> + Unpin,
{
	let json = serde_json::to_string(msg).map_err(|_| ())?;
	write.send(Message::Text(json)).await.map_err(|_| ())
}

/// Extract the `token` query parameter value (no percent-decoding; tokens are
/// generated URL-safe).
pub(crate) fn token_from_query(query: Option<&str>) -> Option<String> {
	let query = query?;
	query.split('&').find_map(|pair| {
		let mut it = pair.splitn(2, '=');
		(it.next() == Some("token")).then(|| it.next().unwrap_or("").to_owned())
	})
}

/// Constant-time-ish token comparison (length is allowed to leak).
pub(crate) fn tokens_match(a: &str, b: &str) -> bool {
	let (a, b) = (a.as_bytes(), b.as_bytes());
	if a.len() != b.len() {
		return false;
	}
	let mut diff = 0u8;
	for (x, y) in a.iter().zip(b) {
		diff |= x ^ y;
	}
	diff == 0
}

#[cfg(test)]
mod tests {
	use futures_util::SinkExt;
	use tokio_tungstenite::connect_async;

	use super::*;
	use crate::protocol::{ActionKind, AskControl, ClientHello, Ping, Reply};

	fn ask(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Ask,
			session_id: "s".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			controls:   vec![],
			summary:    None,
		}
	}

	fn controlled_ask(id: &str) -> ActionNeeded {
		let mut needed = ask(id);
		needed.controls = vec![AskControl {
			id:      "navigation_forward".into(),
			kind:    "navigation".into(),
			label:   "Continue".into(),
			enabled: true,
		}];
		needed
	}

	fn idle(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Idle,
			session_id: "s".into(),
			question:   None,
			options:    None,
			controls:   vec![],
			summary:    Some("idle".into()),
		}
	}

	async fn send_hello(
		ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
		capabilities: Vec<String>,
	) {
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities,
			}))
			.unwrap(),
		))
		.await
		.unwrap();
	}

	async fn next_server_msg<S>(read: &mut S) -> ServerMessage
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		loop {
			let msg = tokio::time::timeout(std::time::Duration::from_secs(2), read.next())
				.await
				.expect("timed out waiting for server message")
				.expect("stream closed")
				.expect("ws error");
			if let Message::Text(t) = msg {
				return serde_json::from_str(t.as_str()).expect("valid server message");
			}
		}
	}

	async fn next_server_hello<S>(read: &mut S) -> ServerHello
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		match next_server_msg(read).await {
			ServerMessage::Hello(hello) => {
				assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
				assert!(
					hello
						.capabilities
						.contains(&capabilities::CLIENT_PING_PONG.into())
				);
				hello
			},
			other => panic!("expected hello, got {other:?}"),
		}
	}

	async fn connect(
		handle: &ServerHandle,
		token: &str,
	) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>> {
		let url = format!("ws://{}/?token={}", handle.addr(), token);
		let (ws, _resp) = connect_async(url).await.expect("connect");
		ws
	}

	#[tokio::test]
	async fn start_binds_ephemeral_port() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		assert_ne!(handle.addr().port(), 0);
		assert!(handle.addr().ip().is_loopback());
		handle.stop();
	}

	#[tokio::test]
	async fn wrong_token_is_rejected() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let url = format!("ws://{}/?token=wrong", handle.addr());
		assert!(connect_async(url).await.is_err());
		handle.stop();
	}

	#[tokio::test]
	async fn ask_broadcast_then_reply_resolves() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		// wait for the client to be subscribed before broadcasting
		wait_for_clients(&handle, 1).await;

		handle.register_ask(ask("a1"), true);
		let got = next_server_msg(&mut ws).await;
		assert!(
			matches!(got, ServerMessage::ActionNeeded(a) if a.id == "a1" && a.kind == ActionKind::Ask)
		);

		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let resolved = next_server_msg(&mut ws).await;
		match resolved {
			ServerMessage::ActionResolved(r) => {
				assert_eq!(r.id, "a1");
				assert_eq!(r.resolved_by, crate::protocol::ResolvedBy::Client);
			},
			other => panic!("expected action_resolved, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn mixed_clients_receive_capability_tailored_controlled_presentations() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut v2 = connect(&handle, "secret").await;
		next_server_hello(&mut v2).await;
		let mut v3 = connect(&handle, "secret").await;
		next_server_hello(&mut v3).await;
		send_hello(&mut v2, vec![]).await;
		send_hello(&mut v3, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		wait_for_clients(&handle, 2).await;

		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(
			next_server_msg(&mut v2).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, reason: ActionUnavailableReason::MissingCapability, .. }) if id == "a1"
		));
		assert!(matches!(
			next_server_msg(&mut v3).await,
			ServerMessage::ActionNeeded(needed) if needed.id == "a1" && !needed.controls.is_empty()
		));
		handle.stop();
	}

	#[tokio::test(start_paused = true)]
	async fn controlled_ask_defers_before_hello_then_times_out_unavailable() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		tokio::task::yield_now().await;
		handle.register_ask(controlled_ask("a1"), true);
		tokio::task::yield_now().await;
		assert!(
			handle
				.state
				.connections
				.lock()
				.values()
				.all(|connection| connection.delivered.is_none())
		);

		tokio::time::advance(CLIENT_HELLO_GRACE).await;
		tokio::task::yield_now().await;
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
		));
		handle.stop();
	}

	#[tokio::test(start_paused = true)]
	async fn hello_timeout_persists_when_idle_for_later_controlled_ask() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		tokio::task::yield_now().await;
		tokio::time::advance(CLIENT_HELLO_GRACE).await;
		tokio::task::yield_now().await;

		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
		));
		handle.stop();
	}

	#[tokio::test]
	async fn unavailable_controlled_ask_upgrades_once_after_capable_hello() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![]).await;
		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
		));

		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionNeeded(needed) if needed.id == "a1" && !needed.controls.is_empty()
		));
		handle.stop();
	}

	#[tokio::test]
	async fn repeated_reduced_hello_never_downgrades_full_controlled_delivery() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		handle.register_ask(controlled_ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;

		send_hello(&mut ws, vec![]).await;
		tokio::task::yield_now().await;
		let connection = handle.state.connections.lock().values().next().cloned();
		assert!(matches!(
			connection,
			Some(Connection {
				negotiation: Negotiation::Negotiated,
				delivered: Some(Delivered { presentation: Presentation::Full, .. }),
				capabilities,
				..
			}) if capabilities.contains(&capabilities::ASK_CONTROLS_V1.into())
		));
		handle.stop();
	}

	#[tokio::test]
	async fn non_capable_controlled_reply_is_rejected_without_claim() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![]).await;
		handle.register_ask(controlled_ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Reply(Reply {
				id:              "a1".into(),
				answer:          ReplyAnswer::Index(0),
				token:           "secret".into(),
				idempotency_key: None,
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ReplyRejected(ReplyRejected { id, reason: RejectReason::InvalidAnswer }) if id == "a1"
		));
		assert!(!handle.state.registry.lock().has_claim_for_action("a1"));
		handle.stop();
	}

	#[tokio::test]
	async fn same_id_replacement_rejects_stale_full_delivery_epoch() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		handle.register_ask(controlled_ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let delivered = handle
			.state
			.connections
			.lock()
			.values()
			.next()
			.and_then(|connection| connection.delivered.clone())
			.expect("full delivery record");
		handle
			.state
			.registry
			.lock()
			.register_ask(controlled_ask("a1"), true);
		assert_ne!(
			delivered.identity,
			handle
				.state
				.registry
				.lock()
				.current_identity()
				.expect("replacement identity")
		);

		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Reply(Reply {
				id:              "a1".into(),
				answer:          ReplyAnswer::Index(0),
				token:           "secret".into(),
				idempotency_key: None,
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ReplyRejected(ReplyRejected { reason: RejectReason::InvalidAnswer, .. })
		));
		assert!(!handle.state.registry.lock().has_claim_for_action("a1"));
		assert!(handle.state.registry.lock().is_pending("a1"));
		handle.stop();
	}

	#[tokio::test]
	async fn deferred_stale_reevaluation_never_writes_resolved_or_replaced_ask() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(controlled_ask("old"), true);
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		tokio::task::yield_now().await;
		handle.resolve_local("old", None);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionResolved(resolved) if resolved.id == "old"
		));
		handle.register_ask(controlled_ask("new"), true);
		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionNeeded(needed) if needed.id == "new"
		));
		handle.stop();
	}

	#[tokio::test]
	async fn reconnect_resets_controlled_delivery_authority_for_the_new_generation() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut first = connect(&handle, "secret").await;
		next_server_hello(&mut first).await;
		send_hello(&mut first, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(next_server_msg(&mut first).await, ServerMessage::ActionNeeded(_)));
		first.close(None).await.unwrap();
		tokio::time::timeout(Duration::from_secs(1), async {
			loop {
				if handle.state.connections.lock().is_empty() {
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.expect("first generation removed");

		let mut second = connect(&handle, "secret").await;
		next_server_hello(&mut second).await;
		let new_connection = handle.state.connections.lock().values().next().cloned();
		assert!(matches!(
			new_connection,
			Some(Connection {
				negotiation: Negotiation::AwaitingHello,
				delivered: None,
				capabilities,
				..
			}) if capabilities.is_empty()
		));

		second
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::Reply(Reply {
					id:              "a1".into(),
					answer:          ReplyAnswer::Index(0),
					token:           "secret".into(),
					idempotency_key: None,
				}))
				.unwrap(),
			))
			.await
			.unwrap();
		assert!(matches!(
			next_server_msg(&mut second).await,
			ServerMessage::ReplyRejected(ReplyRejected { reason: RejectReason::InvalidAnswer, .. })
		));

		send_hello(&mut second, vec![]).await;
		assert!(matches!(
			next_server_msg(&mut second).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
		));
		handle.stop();
	}

	#[tokio::test]
	async fn push_frame_broadcasts_threaded_frames_and_preserves_ask() {
		use crate::protocol::{IdentityHeader, TurnPhase, TurnStream};
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		handle
			.push_frame(ServerMessage::IdentityHeader(IdentityHeader {
				session_id: "s".into(),
				repo:       "sayknow-cli".into(),
				branch:     "feat/notification-surface".into(),
				machine:    "m1".into(),
				title:      Some("Session".into()),
			}))
			.unwrap();
		match next_server_msg(&mut ws).await {
			ServerMessage::IdentityHeader(h) => assert_eq!(h.repo, "sayknow-cli"),
			other => panic!("expected identity_header, got {other:?}"),
		}

		handle
			.push_frame(ServerMessage::TurnStream(TurnStream {
				session_id:   "s".into(),
				phase:        TurnPhase::Finalized,
				text:         "done".into(),
				final_answer: None,
				message_ref:  None,
			}))
			.unwrap();
		match next_server_msg(&mut ws).await {
			ServerMessage::TurnStream(t) => {
				assert_eq!(t.phase, TurnPhase::Finalized);
				assert_eq!(t.text, "done");
			},
			other => panic!("expected turn_stream, got {other:?}"),
		}

		// Asks share the connection-local reevaluation path alongside streaming frames.
		handle.register_ask(ask("a1"), true);
		match next_server_msg(&mut ws).await {
			ServerMessage::ActionNeeded(a) => assert_eq!(a.id, "a1"),
			other => panic!("expected action_needed, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn push_frame_rejects_asks_and_egress_filter_allows_only_idle_broadcasts() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		assert_eq!(
			handle.push_frame(ServerMessage::ActionNeeded(controlled_ask("blocked"))),
			Err(PushFrameError::ActionNeededProhibited),
		);
		let _ = handle
			.state
			.tx
			.send(ServerMessage::ActionNeeded(controlled_ask("injected")));
		assert!(
			tokio::time::timeout(Duration::from_millis(50), ws.next())
				.await
				.is_err()
		);

		handle.note_idle(idle("idle-1"));
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionNeeded(needed)
				if needed.kind == ActionKind::Idle && needed.id == "idle-1" && needed.controls.is_empty()
		));
		handle.stop();
	}

	#[tokio::test]
	async fn unknown_action_reply_is_rejected_to_sender() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let reply = Reply {
			id:              "ghost".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let rejected = next_server_msg(&mut ws).await;
		match rejected {
			ServerMessage::ReplyRejected(r) => {
				assert_eq!(r.id, "ghost");
				assert_eq!(r.reason, crate::protocol::RejectReason::UnknownAction);
			},
			other => panic!("expected reply_rejected, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn late_client_gets_buffered_ask_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		// register before any client connects
		handle.register_ask(ask("a1"), true);
		// connect afterwards: should receive the buffered ask on connect
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		let got = next_server_msg(&mut ws).await;
		assert!(matches!(got, ServerMessage::ActionNeeded(a) if a.id == "a1"));
		handle.stop();
	}

	#[tokio::test]
	async fn hello_before_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(ask("a1"), true);

		let mut ws = connect(&handle, "secret").await;
		let hello = next_server_hello(&mut ws).await;
		assert_eq!(hello.capabilities, vec![
			capabilities::THREADED,
			capabilities::CONTEXT,
			capabilities::TURN_STREAM,
			capabilities::IMAGES,
			capabilities::CONFIG,
			capabilities::CLIENT_PING_PONG,
			capabilities::SESSION_READY,
			capabilities::ASK_CONTROLS_V1,
			capabilities::ASK_SELECTED_ACK_V1,
		]);

		match next_server_msg(&mut ws).await {
			ServerMessage::ActionNeeded(a) => assert_eq!(a.id, "a1"),
			other => panic!("expected replayed action_needed, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn ping_gets_pong() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut sender = connect(&handle, "secret").await;
		next_server_hello(&mut sender).await;
		let mut other = connect(&handle, "secret").await;
		next_server_hello(&mut other).await;
		wait_for_clients(&handle, 2).await;

		sender
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::Ping(Ping { nonce: "n1".into() })).unwrap(),
			))
			.await
			.unwrap();

		match next_server_msg(&mut sender).await {
			ServerMessage::Pong(p) => assert_eq!(p.nonce, "n1"),
			other => panic!("expected pong, got {other:?}"),
		}
		let broadcast =
			tokio::time::timeout(std::time::Duration::from_millis(300), next_server_msg(&mut other))
				.await;
		assert!(broadcast.is_err(), "pong must not be broadcast");
		handle.stop();
	}

	#[tokio::test]
	async fn resolve_local_broadcasts_resolved() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _needed = next_server_msg(&mut ws).await;

		handle.resolve_local("a1", None);
		let resolved = next_server_msg(&mut ws).await;
		match resolved {
			ServerMessage::ActionResolved(r) => {
				assert_eq!(r.id, "a1");
				assert_eq!(r.resolved_by, crate::protocol::ResolvedBy::Local);
			},
			other => panic!("expected action_resolved local, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn stop_is_idempotent() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.stop();
		handle.stop();
		handle.stop();
	}

	#[tokio::test]
	async fn forward_mode_routes_reply_to_host_then_resolves() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut rx = handle.take_reply_receiver().expect("forward receiver");
		assert!(handle.take_reply_receiver().is_none(), "receiver is take-once");

		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _needed = next_server_msg(&mut ws).await;

		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(1),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let fwd = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
			.await
			.expect("forward timeout")
			.expect("reply forwarded");
		assert_eq!(fwd.reply.id, "a1");

		assert_eq!(fwd.reply.answer, ReplyAnswer::Index(1));

		assert!(!handle.resolve_client("a1", Some(ReplyAnswer::Index(1)), None));
		assert!(!handle.resolve_claim("stale-receipt", Some(ReplyAnswer::Index(1)), None));
		assert!(!handle.close_claim_invalid("stale-receipt"));
		assert!(!handle.cancel_claim("stale-receipt"));
		assert!(handle.resolve_claim(&fwd.reply_receipt_id, Some(ReplyAnswer::Index(1)), None));
		let resolved = next_server_msg(&mut ws).await;
		assert!(
			matches!(resolved, ServerMessage::ActionResolved(r) if r.id == "a1" && r.resolved_by == crate::protocol::ResolvedBy::Client)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn live_selected_ack_is_origin_bound_and_correlated() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut replies = handle.take_reply_receiver().expect("forward receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities:     vec![capabilities::ASK_SELECTED_ACK_V1.into()],
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: Some("k1".into()),
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let claim = replies.recv().await.expect("claimed reply");
		let request = AskSelectedAckRequest::Live {
			request_id:  "r1".into(),
			commit_key:  "c1".into(),
			action_id:   "a1".into(),
			deadline_at: (std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_millis()
				+ 5_000) as i64,
		};
		let request_task = {
			let handle = handle.clone();
			let receipt = claim.reply_receipt_id.clone();
			tokio::spawn(async move { handle.request_ask_selected_ack(&receipt, request).await })
		};
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::AskSelectedAckRequest(AskSelectedAckRequest::Live { request_id, commit_key, .. })
				if request_id == "r1" && commit_key == "c1"
		));
		let mut wrong_origin = connect(&handle, "secret").await;
		next_server_hello(&mut wrong_origin).await;
		let _ = next_server_msg(&mut wrong_origin).await;
		wrong_origin
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::AskSelectedAckResult(
					crate::protocol::AskSelectedAckResult {
						request_id: "r1".into(),
						commit_key: "c1".into(),
						outcome:    AskSelectedAckOutcome::Delivered { message_id: 99 },
					},
				))
				.unwrap(),
			))
			.await
			.unwrap();
		tokio::time::sleep(Duration::from_millis(20)).await;
		assert!(!request_task.is_finished(), "wrong-origin result settled request");
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::AskSelectedAckResult(
				crate::protocol::AskSelectedAckResult {
					request_id: "r1".into(),
					commit_key: "c1".into(),
					outcome:    AskSelectedAckOutcome::Delivered { message_id: 42 },
				},
			))
			.unwrap(),
		))
		.await
		.unwrap();
		assert_eq!(request_task.await.unwrap(), AskSelectedAckOutcome::Delivered { message_id: 42 });
		handle.resolve_claim(&claim.reply_receipt_id, Some(ReplyAnswer::Index(0)), Some("k1".into()));
		assert!(matches!(next_server_msg(&mut ws).await, ServerMessage::ActionResolved(_)));
		handle.stop();
	}

	#[tokio::test]
	async fn dispatched_acknowledgement_disconnect_is_unknown() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut replies = handle.take_reply_receiver().expect("forward receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities:     vec![capabilities::ASK_SELECTED_ACK_V1.into()],
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Reply(Reply {
				id:              "a1".into(),
				answer:          ReplyAnswer::Index(0),
				token:           "secret".into(),
				idempotency_key: Some("k1".into()),
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		let claim = replies.recv().await.expect("claimed reply");
		let task = {
			let handle = handle.clone();
			let receipt = claim.reply_receipt_id.clone();
			tokio::spawn(async move {
				handle
					.request_ask_selected_ack(&receipt, AskSelectedAckRequest::Live {
						request_id:  "disconnect-request".into(),
						commit_key:  "disconnect-commit".into(),
						action_id:   "a1".into(),
						deadline_at: (std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis() + 5_000) as i64,
					})
					.await
			})
		};
		assert!(matches!(next_server_msg(&mut ws).await, ServerMessage::AskSelectedAckRequest(_)));
		ws.close(None).await.unwrap();
		assert_eq!(task.await.unwrap(), AskSelectedAckOutcome::Unknown {
			reason: AskSelectedAckUnknownReason::OriginDisconnected,
		});
		handle.stop();
	}

	#[tokio::test]
	async fn stop_terminalizes_pending_acknowledgement_and_preserves_cancel_reason() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities:     vec![capabilities::ASK_SELECTED_ACK_V1.into()],
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		wait_for_clients(&handle, 1).await;
		tokio::time::sleep(Duration::from_millis(20)).await;
		let task = {
			let handle = handle.clone();
			tokio::spawn(async move {
				handle
					.request_recovered_ask_selected_ack(AskSelectedAckRequest::Recovery {
						request_id:  "shutdown-request".into(),
						commit_key:  "shutdown-commit".into(),
						session_id:  "s".into(),
						action_id:   "a1".into(),
						deadline_at: (std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis() + 5_000) as i64,
					})
					.await
			})
		};
		assert!(matches!(next_server_msg(&mut ws).await, ServerMessage::AskSelectedAckRequest(_)));
		handle.stop();
		assert_eq!(task.await.unwrap(), AskSelectedAckOutcome::Unknown {
			reason: AskSelectedAckUnknownReason::Shutdown,
		});
		assert_eq!(
			handle
				.request_ack(
					AskSelectedAckRequest::Recovery {
						request_id:  "after-stop-request".into(),
						commit_key:  "after-stop-commit".into(),
						session_id:  "s".into(),
						action_id:   "a2".into(),
						deadline_at: (std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis() + 5_000) as i64,
					},
					None
				)
				.await,
			AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::Shutdown }
		);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::AskSelectedAckCancel(AskSelectedAckCancel {
				reason: AskSelectedAckCancelReason::SessionShutdown,
				..
			})
		));
	}

	#[tokio::test]
	async fn live_selected_ack_requires_capability() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut replies = handle.take_reply_receiver().expect("forward receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let claim = replies.recv().await.expect("claimed reply");
		let outcome = handle
			.request_ask_selected_ack(&claim.reply_receipt_id, AskSelectedAckRequest::Live {
				request_id:  "r1".into(),
				commit_key:  "c1".into(),
				action_id:   "a1".into(),
				deadline_at: 123,
			})
			.await;
		assert_eq!(outcome, AskSelectedAckOutcome::Failed {
			reason: AskSelectedAckFailedReason::Unsupported,
		});
		handle.stop();
	}

	#[tokio::test]
	async fn dropped_host_receiver_terminalizes_claim_instead_of_orphaning_it() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		drop(handle.take_reply_receiver().expect("forward receiver"));
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionResolved(resolved) if resolved.id == "a1" && resolved.answer.is_none()
		));
		handle.stop();
	}

	#[tokio::test]
	async fn forward_mode_rejects_unknown_action_without_host() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let _rx = handle.take_reply_receiver();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let reply = Reply {
			id:              "ghost".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let rejected = next_server_msg(&mut ws).await;
		assert!(
			matches!(rejected, ServerMessage::ReplyRejected(r) if r.id == "ghost" && r.reason == crate::protocol::RejectReason::UnknownAction)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn writes_and_removes_endpoint_discovery_file() {
		let root = std::env::temp_dir().join(format!(
			"skc-notif-srv-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir_all(&root).unwrap();

		let mut config = ServerConfig::new("sess-disc", "secret");
		config.state_root = Some(root.clone());
		let handle = start(config).await.unwrap();

		let path = crate::discovery::endpoint_path(&root, "sess-disc");
		let record = crate::discovery::read_endpoint(&path).expect("endpoint file written");
		assert_eq!(record.port, handle.addr().port());
		assert_eq!(record.token, "secret");
		assert!(record.url.starts_with("ws://127.0.0.1:"));

		handle.stop();
		assert!(crate::discovery::read_endpoint(&path).is_none(), "endpoint removed on stop");
		std::fs::remove_dir_all(&root).ok();
	}

	async fn wait_for_clients(handle: &ServerHandle, n: usize) {
		for _ in 0..200 {
			if handle.client_count() >= n {
				return;
			}
			tokio::time::sleep(std::time::Duration::from_millis(10)).await;
		}
		panic!("clients did not subscribe in time");
	}

	#[tokio::test]
	async fn inbound_user_message_forwards_to_host() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::UserMessage(crate::protocol::UserMessage {
				session_id: "s".into(),
				text:       "keep going".into(),
				token:      "secret".into(),
				update_id:  Some(7),
				thread_id:  Some("topic-1".into()),
				images:     vec![],
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let got = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("inbound timed out")
			.expect("inbound channel closed");
		match got {
			ClientMessage::UserMessage(u) => {
				assert_eq!(u.text, "keep going");
				assert_eq!(u.update_id, Some(7));
				assert_eq!(u.thread_id.as_deref(), Some("topic-1"));
			},
			other => panic!("expected user_message, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn inbound_control_command_forwards_to_host() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::ControlCommand(crate::protocol::ControlCommand {
				session_id: "s".into(),
				token:      "secret".into(),
				request_id: "r1".into(),
				update_id:  Some(8),
				thread_id:  Some("topic-1".into()),
				command:    serde_json::json!({ "name": "context" }),
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let got = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("inbound timed out")
			.expect("inbound channel closed");
		match got {
			ClientMessage::ControlCommand(c) => {
				assert_eq!(c.request_id, "r1");
				assert_eq!(c.update_id, Some(8));
				assert_eq!(c.command["name"], "context");
			},
			other => panic!("expected control_command, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn inbound_user_message_wrong_token_is_dropped() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::UserMessage(crate::protocol::UserMessage {
				session_id: "s".into(),
				text:       "x".into(),
				token:      "WRONG".into(),
				update_id:  None,
				thread_id:  None,
				images:     vec![],
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let r = tokio::time::timeout(std::time::Duration::from_millis(300), inbound.recv()).await;
		assert!(r.is_err(), "wrong-token inbound must not forward");
		handle.stop();
	}

	#[tokio::test]
	async fn session_ready_is_advertised_buffered_and_replayed() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();

		// A client connected before readiness sees it broadcast live.
		let mut early = connect(&handle, "secret").await;
		let hello = next_server_hello(&mut early).await;
		assert!(
			hello
				.capabilities
				.contains(&capabilities::SESSION_READY.into())
		);
		wait_for_clients(&handle, 1).await;

		handle.push_session_ready(SessionReady {
			session_id:           "s".into(),
			lifecycle_request_id: Some("lc_01".into()),
			startup_prompt_ref:   Some("prompt_lc_01".into()),
			repo:                 Some("sayknow-cli".into()),
			branch:               Some("feat/x".into()),
			title:                None,
		});
		match next_server_msg(&mut early).await {
			ServerMessage::SessionReady(r) => {
				assert_eq!(r.session_id, "s");
				assert_eq!(r.lifecycle_request_id.as_deref(), Some("lc_01"));
			},
			other => panic!("expected session_ready broadcast, got {other:?}"),
		}

		// A client connecting AFTER readiness still gets it replayed on connect.
		let mut late = connect(&handle, "secret").await;
		next_server_hello(&mut late).await;
		match next_server_msg(&mut late).await {
			ServerMessage::SessionReady(r) => assert_eq!(r.session_id, "s"),
			other => panic!("expected replayed session_ready, got {other:?}"),
		}
		handle.stop();
	}
	#[tokio::test]
	async fn send_failure_after_dispatch_begins_is_transport_ambiguous() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let (tx, mut rx) = mpsc::unbounded_channel::<DirectCommand>();
		handle
			.state
			.connections
			.lock()
			.insert("origin".into(), Connection {
				generation: "generation".into(),
				capabilities: vec![capabilities::ASK_SELECTED_ACK_V1.into()],
				negotiation: Negotiation::Negotiated,
				delivered: None,
				tx,
			});
		let task = {
			let handle = handle.clone();
			tokio::spawn(async move {
				handle
					.request_ack(
						AskSelectedAckRequest::Recovery {
							request_id:  "send-failure-request".into(),
							commit_key:  "send-failure-commit".into(),
							session_id:  "s".into(),
							action_id:   "a1".into(),
							deadline_at: (std::time::SystemTime::now()
								.duration_since(std::time::UNIX_EPOCH)
								.unwrap()
								.as_millis() + 5_000) as i64,
						},
						Some(("origin".into(), "generation".into())),
					)
					.await
			})
		};
		let direct = rx.recv().await.expect("queued acknowledgement");
		let DirectCommand::Deliver(message, Some(dispatched)) = direct else {
			panic!("expected acknowledgement delivery command");
		};
		assert!(prepare_direct_ack(&handle.state, &message));
		dispatched.send(false).unwrap();
		assert_eq!(task.await.unwrap(), AskSelectedAckOutcome::Unknown {
			reason: AskSelectedAckUnknownReason::TransportAmbiguous,
		});
		handle.stop();
	}
	#[test]
	fn acknowledgement_registry_linearizes_dispatch_terminal_and_cancel() {
		let mut registry = AckRegistry::default();
		let (waiter, receiver) = oneshot::channel();
		registry.commits.insert("commit".into(), "request".into());
		registry.pending.insert("request".into(), AckPending {
			commit_key: "commit".into(),
			origin: None,
			dispatched: false,
			waiter,
		});
		let delivered = AskSelectedAckOutcome::Delivered { message_id: 42 };
		let unknown =
			AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout };
		assert!(registry.begin_dispatch("request"));
		let (actual, finished) = registry.finish("request", delivered.clone());
		assert_eq!(actual, delivered);
		assert!(finished.expect("first settlement").2);
		assert!(!registry.begin_dispatch("request"));
		assert_eq!(registry.finish("request", unknown).0, delivered);
		let cancelled =
			AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Cancelled };
		assert_eq!(registry.cancel("request", "commit", cancelled.clone()).0, delivered);
		assert_eq!(
			registry
				.cancel("request", "wrong-commit", cancelled.clone())
				.0,
			cancelled
		);
		assert_eq!(receiver.blocking_recv().unwrap(), delivered);
	}
}
