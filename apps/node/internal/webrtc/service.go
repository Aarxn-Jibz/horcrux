package webrtc

import (
	"context"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
	"github.com/pion/webrtc/v4"
	"log/slog"
	"os"
	"time"
)

type Service struct {
	Manager  *Manager
	Signals  *SignalingClient
	NodeID   string
	Store    *storage.Store
	Verifier authorization.Verifier
	Signer   receipt.PayloadSigner
}

func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.Manager.CloseAll()
			return
		case <-ticker.C:
			s.poll(ctx)
		}
	}
}
func (s *Service) poll(ctx context.Context) {
	sessions, err := s.Signals.Sessions(ctx)
	if err != nil {
		return
	}
	s.Manager.CloseExcept(sessions)
	for _, id := range sessions {
		signals, err := s.Signals.Exchange(ctx, id, nil)
		if err != nil {
			continue
		}
		for _, signal := range signals {
			if signal.Type != "offer" {
				continue
			}
			servers, iceErr := s.Signals.ICE(ctx, id)
			if iceErr != nil {
				slog.Debug("webrtc ICE configuration rejected", "error", iceErr)
				continue
			}
			answer, err := s.Manager.AcceptOffer(ctx, id, signal.Payload, servers, func(channel *webrtc.DataChannel) {
				session := NewObjectSession(ctx, s.NodeID, s.Store, s.Verifier, s.Signer)
				channel.OnMessage(func(message webrtc.DataChannelMessage) {
					if message.IsString {
						control, err := ParseControl(message.Data)
						if err != nil {
							_ = channel.SendText(`{"type":"error","message":"invalid control"}`)
							return
						}
						switch control.Type {
						case "put-init":
							err = session.Begin(control)
						case "put-finish":
							var response Control
							response, err = session.Finish()
							if err == nil {
								raw, _ := response.Bytes()
								_ = channel.SendText(string(raw))
							}
						case "get":
							var response Control
							response, err = session.Get(control, func(chunk []byte) error { return channel.Send(chunk) })
							if err == nil {
								raw, _ := response.Bytes()
								_ = channel.SendText(string(raw))
							}
						case "delete":
							err = session.Delete(control)
							if err == nil {
								_ = channel.SendText(`{"type":"delete-finish"}`)
							}
						}
						if err != nil {
							_ = channel.SendText(`{"type":"error","message":"operation rejected"}`)
						}
					} else {
						if err := session.Write(message.Data); err != nil {
							_ = channel.SendText(`{"type":"error","message":"binary rejected"}`)
						}
					}
				})
				channel.OnClose(session.Abort)
			})
			if err == nil {
				if _, exchangeErr := s.Signals.Exchange(ctx, id, &Signal{Type: "answer", Payload: answer}); exchangeErr != nil {
					slog.Debug("webrtc answer relay rejected", "error", exchangeErr)
				} else if os.Getenv("HORCRUX_WEBRTC_DEBUG") == "1" {
					slog.Info("webrtc answer relayed", "session", id)
				}
			} else {
				slog.Debug("webrtc offer rejected", "error", err)
			}
		}
	}
}
