package webrtc

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"github.com/pion/webrtc/v4"
)

// Manager owns only short-lived peers created from an authenticated signaling session.
type Manager struct {
	mu         sync.Mutex
	peers      map[string]*webrtc.PeerConnection
	candidates map[string]map[string]struct{}
	config     webrtc.Configuration
	api        *webrtc.API
}

func NewManager(servers []webrtc.ICEServer) *Manager {
	engine := webrtc.SettingEngine{}
	// Loopback candidates are intentionally enabled for direct local/LAN
	// development. Production NAT traversal still relies on configured ICE.
	engine.SetIncludeLoopbackCandidate(true)
	return &Manager{peers: map[string]*webrtc.PeerConnection{}, candidates: map[string]map[string]struct{}{}, config: webrtc.Configuration{ICEServers: servers}, api: webrtc.NewAPI(webrtc.WithSettingEngine(engine))}
}

func (m *Manager) HasPeer(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, exists := m.peers[sessionID]
	return exists
}

func (m *Manager) AcceptOffer(ctx context.Context, sessionID, encoded string, servers []webrtc.ICEServer, onChannel func(*webrtc.DataChannel), onCandidate func(string)) (string, error) {
	debug := os.Getenv("HORCRUX_WEBRTC_DEBUG") == "1"
	m.mu.Lock()
	if _, exists := m.peers[sessionID]; exists {
		m.mu.Unlock()
		return "", fmt.Errorf("session already has a peer")
	}
	m.mu.Unlock()
	configuration := m.config
	configuration.ICEServers = servers
	connection, err := m.api.NewPeerConnection(configuration)
	if err != nil {
		return "", err
	}
	connection.OnDataChannel(func(channel *webrtc.DataChannel) {
		if debug {
			slog.Info("webrtc data channel", "session", sessionID, "label", channel.Label())
			channel.OnOpen(func() { slog.Info("webrtc data channel open", "session", sessionID, "label", channel.Label()) })
		}
		if channel.Label() == "horcrux" {
			onChannel(channel)
		}
	})
	if debug {
		connection.OnICEGatheringStateChange(func(state webrtc.ICEGatheringState) {
			slog.Info("webrtc ICE gathering", "session", sessionID, "state", state.String())
		})
		connection.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
			slog.Info("webrtc ICE connection", "session", sessionID, "state", state.String())
		})
	}
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if debug {
			slog.Info("webrtc peer connection", "session", sessionID, "state", state.String())
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.Close(sessionID)
			_ = connection.Close() // The peer may fail before it is entered in m.peers.
		}
	})
	connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			raw, err := json.Marshal(candidate.ToJSON())
			if err == nil {
				onCandidate(string(raw))
			}
		}
		if debug {
			if candidate == nil {
				slog.Info("webrtc local ICE candidates complete", "session", sessionID)
				return
			}
			slog.Info("webrtc local ICE candidate", "session", sessionID, "candidate", candidate.String())
		}
	})
	if debug {
		connection.SCTP().Transport().ICETransport().OnSelectedCandidatePairChange(func(pair *webrtc.ICECandidatePair) {
			slog.Info("webrtc selected ICE candidate pair", "session", sessionID, "local", pair.Local.String(), "remote", pair.Remote.String())
		})
	}
	if err := connection.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: encoded}); err != nil {
		connection.Close()
		return "", err
	}
	answer, err := connection.CreateAnswer(nil)
	if err != nil {
		connection.Close()
		return "", err
	}
	if err := connection.SetLocalDescription(answer); err != nil {
		connection.Close()
		return "", err
	}
	m.mu.Lock()
	m.peers[sessionID] = connection
	m.candidates[sessionID] = map[string]struct{}{}
	m.mu.Unlock()
	go func() { <-ctx.Done(); m.Close(sessionID) }()
	return connection.LocalDescription().SDP, nil
}

// AddICECandidate accepts browser trickle candidates after the offer is relayed.
func (m *Manager) AddICECandidate(sessionID, encoded string) error {
	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal([]byte(encoded), &candidate); err != nil {
		return err
	}
	m.mu.Lock()
	peer := m.peers[sessionID]
	if peer == nil {
		m.mu.Unlock()
		return nil
	}
	seen := m.candidates[sessionID]
	if _, exists := seen[encoded]; exists {
		m.mu.Unlock()
		return nil
	}
	seen[encoded] = struct{}{}
	m.mu.Unlock()
	if err := peer.AddICECandidate(candidate); err != nil {
		m.mu.Lock()
		delete(m.candidates[sessionID], encoded)
		m.mu.Unlock()
		return err
	}
	return nil
}
func (m *Manager) Close(sessionID string) {
	m.mu.Lock()
	peer := m.peers[sessionID]
	delete(m.peers, sessionID)
	delete(m.candidates, sessionID)
	m.mu.Unlock()
	if peer != nil {
		_ = peer.Close()
	}
}
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.peers))
	for id := range m.peers {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Close(id)
	}
}

// CloseExcept drops peers whose signaling sessions have expired or disappeared.
func (m *Manager) CloseExcept(sessionIDs []string) {
	active := make(map[string]struct{}, len(sessionIDs))
	for _, id := range sessionIDs {
		active[id] = struct{}{}
	}
	m.mu.Lock()
	ids := make([]string, 0)
	for id := range m.peers {
		if _, ok := active[id]; !ok {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Close(id)
	}
}
