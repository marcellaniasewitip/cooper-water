import CooperKit
import SwiftUI

struct DriverChatListScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @State private var chats: [ChatConversation] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if let error { ErrorBanner(error) { Task { await load() } } }
            if !loading && chats.isEmpty && error == nil {
                EmptyState("No messages yet. You can chat with a customer once you accept their order.", systemImage: "envelope")
            }
            ForEach(chats) { c in
                Button { router.go(.chat(orderId: c.orderId)) } label: { ConversationRow(c: c, fallbackName: "Customer") }
                    .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .cwTitle("Messages")
        .task { await load() }
        .refreshable { await load() }
        .onReceive(session.realtime.events) { e in if case .chatMessage = e { Task { await load() } } }
    }

    private func load() async {
        do {
            chats = try await state.api.chats()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

struct DriverChatScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    let orderId: String
    @State private var thread: ChatThread?
    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        let name = (thread?.otherName).flatMap { $0.isEmpty ? nil : $0 }
        ChatView(
            title: thread?.shortCode.map { "Chat · \($0)" } ?? "Chat",
            subtitle: name,
            messages: thread?.messages ?? [],
            open: thread?.open ?? true,
            loaded: thread != nil,
            emptyText: "No messages yet. Say hello to \(name ?? "the customer").",
            draft: $draft,
            sending: sending,
            error: error,
            onSend: send
        )
        .task { await load() }
        .onReceive(session.realtime.events) { e in
            if case .chatMessage(let id, _, _) = e, id == orderId { Task { await load() } }
        }
    }

    private func load() async {
        do {
            thread = try await state.api.messages(orderId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !sending else { return }
        sending = true
        Task {
            do {
                _ = try await state.api.send(orderId, body: body)
                draft = ""
                await load()
            } catch {
                self.error = error.localizedDescription
            }
            sending = false
        }
    }
}

/// Messages Cooper Waters sent to drivers from the admin (Push messages), newest first.
struct AnnouncementsScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @StateObject private var list = CursorList<InboxItem>()

    var body: some View {
        List {
            if let e = list.error { ErrorBanner(e) { Task { await list.refresh() } } }
            if !list.loading && list.items.isEmpty && list.error == nil {
                EmptyState("No announcements yet. Messages from Cooper Waters will appear here.", systemImage: "info.circle")
            }
            ForEach(list.items) { n in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "info.circle.fill").foregroundColor(.cwBlue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.title ?? "").font(.headline)
                        Text(n.body ?? "").font(.subheadline)
                        Text(PomTime.formatDateTime(n.createdAt)).font(.caption).foregroundColor(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            if !list.endReached && !list.items.isEmpty { Button("Show older") { Task { await list.loadMore() } } }
        }
        .listStyle(.plain)
        .cwTitle("Announcements")
        .task {
            let api = state.api
            list.setFetch { cursor in try await api.inbox(cursor: cursor) }
            await list.refresh()
        }
        .refreshable { await list.refresh() }
        .onReceive(session.realtime.events) { e in if case .message = e { Task { await list.refresh() } } }
    }
}

struct DriverProfileScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    let onboarding: Bool
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("Your full name", text: $name).textContentType(.name)
                LabelValue("Phone", session.user?.phone ?? state.profile?.phone ?? "")
                if let r = state.profile?.ratingAvg, r > 0 { LabelValue("Rating", String(format: "★ %.1f (%d)", r, state.profile?.ratingCount ?? 0)) }
                if let t = state.profile?.truck { LabelValue("Truck", "\(t.plate) · \(t.capacityLitres) L") }
            }
            if let error { Section { ErrorBanner(error) } }
            Section {
                PrimaryButton(onboarding ? "Continue" : "Save", busy: busy, enabled: name.trimmingCharacters(in: .whitespaces).count >= 2) { save() }
                    .listRowInsets(EdgeInsets())
            }
            if !onboarding {
                Section { Button("Sign out", role: .destructive) { session.signOut() } }
            }
        }
        .cwTitle(onboarding ? "Welcome" : "Profile")
        .onAppear { if name.isEmpty { name = state.profile?.name ?? session.user?.name ?? "" } }
    }

    private func save() {
        busy = true
        error = nil
        let n = name.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                state.setProfile(try await state.api.updateMe(name: n))
                session.updateUserName(n)
                if !onboarding { router.back() }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

struct DriverSupportScreen: View {
    @EnvironmentObject var session: AppSession
    @State private var message = ""
    @State private var noMail = false
    private let to = "support@cooperwaters.com"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Send us a mail").font(.title3.bold())
                TextEditor(text: $message).frame(minHeight: 160).padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                if noMail { Text("No email app found. Please email \(to).").foregroundColor(.cwRed).font(.subheadline) }
                PrimaryButton("Continue", enabled: !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { send() }
            }
            .padding(16)
        }
        .cwTitle("Support")
    }

    private func send() {
        var c = URLComponents()
        c.scheme = "mailto"
        c.path = to
        c.queryItems = [URLQueryItem(name: "subject", value: "Cooper Waters driver support (\(session.user?.phone ?? ""))"), URLQueryItem(name: "body", value: message)]
        guard let url = c.url else { return }
        UIApplication.shared.open(url) { ok in noMail = !ok }
    }
}
