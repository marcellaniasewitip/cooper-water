#if canImport(UIKit)
import SwiftUI

/// One row in a chat list: other person, order code, last message, unread badge.
public struct ConversationRow: View {
    let c: ChatConversation
    let fallbackName: String
    public init(c: ChatConversation, fallbackName: String) {
        self.c = c
        self.fallbackName = fallbackName
    }
    public var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("\((c.otherName ?? "").isEmpty ? fallbackName : c.otherName!) · \(c.shortCode ?? "")").font(.headline)
                Text(c.lastMessage.map { ($0.mine == true ? "You: " : "") + $0.body } ?? "No messages yet")
                    .font(.subheadline).foregroundColor(.secondary).lineLimit(1)
                Text(PomTime.formatDateTime(c.lastMessage?.createdAt ?? c.updatedAt)).font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            if let u = c.unread, u > 0 {
                Text(u > 9 ? "9+" : "\(u)").font(.caption.bold()).foregroundColor(.white)
                    .frame(width: 24, height: 24).background(Circle().fill(Color.cwBlue))
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

/// Chat thread UI (bubbles + composer), shared by both apps.
public struct ChatView: View {
    let title: String
    let subtitle: String?
    let messages: [ChatMessage]
    let open: Bool
    let loaded: Bool
    let emptyText: String
    @Binding var draft: String
    let sending: Bool
    let error: String?
    let onSend: () -> Void

    public init(title: String, subtitle: String?, messages: [ChatMessage], open: Bool, loaded: Bool, emptyText: String,
                draft: Binding<String>, sending: Bool, error: String?, onSend: @escaping () -> Void) {
        self.title = title
        self.subtitle = subtitle
        self.messages = messages
        self.open = open
        self.loaded = loaded
        self.emptyText = emptyText
        _draft = draft
        self.sending = sending
        self.error = error
        self.onSend = onSend
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let subtitle { Text(subtitle).font(.caption).foregroundColor(.secondary).padding(.vertical, 4) }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        if loaded && messages.isEmpty { Text(emptyText).foregroundColor(.secondary).padding(.top, 20) }
                        ForEach(messages) { m in bubble(m).id(m.id) }
                    }
                    .padding(16)
                }
                .onChange(of: messages.count) { _ in
                    if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
                .onAppear { if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            if let error { ErrorBanner(error).padding(.horizontal, 16) }
            if loaded && !open {
                Text("This order is finished, so the chat is closed.").font(.subheadline).foregroundColor(.secondary).padding(16)
            } else {
                HStack(spacing: 8) {
                    TextField("Type a message", text: $draft, axis: .vertical).lineLimit(1...4)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 22).stroke(Color.secondary.opacity(0.35)))
                    Button(action: onSend) {
                        Image(systemName: "paperplane.fill").foregroundColor(.white).padding(12).background(Circle().fill(Color.cwBlue))
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || !loaded)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        .cwTitle(title)
    }

    private func bubble(_ m: ChatMessage) -> some View {
        let mine = m.mine == true
        return HStack {
            if mine { Spacer(minLength: 50) }
            VStack(alignment: .leading, spacing: 2) {
                Text(m.body).foregroundColor(mine ? .white : .primary)
                Text(PomTime.formatTime(m.createdAt)).font(.caption2).foregroundColor(mine ? .white.opacity(0.8) : .secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 16).fill(mine ? Color.cwBlue : Color(UIColor.secondarySystemBackground)))
            if !mine { Spacer(minLength: 50) }
        }
    }
}
#endif
