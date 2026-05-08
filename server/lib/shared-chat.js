/**
 * Shared Chat Service
 *
 * Manages a unified chat that agent, assistant AI, and user can all access.
 * Provides message persistence, real-time broadcasting, and flexible participant support.
 */
import { randomUUID } from 'node:crypto';
import { broadcast } from '../routes/events.js';
// ── SharedChatService Class ─────────────────────────────────────────
class SharedChatService {
    messages = [];
    participants = new Map();
    sequenceCounter = 0;
    config;
    constructor(config) {
        this.config = {
            maxMessages: config?.maxMessages ?? 10_000,
            cleanupIntervalMs: config?.cleanupIntervalMs ?? 60_000, // 1 minute
            participantTtlMs: config?.participantTtlMs ?? 300_000, // 5 minutes
        };
        // Start cleanup interval
        if (this.config.cleanupIntervalMs > 0) {
            setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
        }
    }
    /**
     * Add a message to the shared chat
     */
    async addMessage(options) {
        const message = {
            id: `msg-${randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            sequenceNumber: ++this.sequenceCounter,
            ...options,
        };
        // Store the message
        this.messages.push(message);
        // Trim old messages if needed
        while (this.messages.length > this.config.maxMessages) {
            this.messages.shift();
        }
        // Broadcast to all subscribers
        broadcast('shared-chat.message', { message });
        return message;
    }
    /**
     * Get messages with optional filters
     */
    getMessages(options) {
        let result = [...this.messages];
        if (options) {
            if (options.participantId) {
                result = result.filter(m => m.participantId === options.participantId);
            }
            if (options.participantType) {
                result = result.filter(m => m.participantType === options.participantType);
            }
            if (options.before) {
                const beforeDate = typeof options.before === 'string' ? new Date(options.before) : options.before;
                result = result.filter(m => m.timestamp < beforeDate.toISOString());
            }
            if (options.after) {
                const afterDate = typeof options.after === 'string' ? new Date(options.after) : options.after;
                result = result.filter(m => m.timestamp > afterDate.toISOString());
            }
        }
        // Sort by sequence number (newest first by default)
        result.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        const limit = options?.limit ?? 100;
        const offset = options?.offset ?? 0;
        return result.slice(offset, offset + limit);
    }
    /**
     * Get recent messages from all participants
     */
    getRecentMessages(options) {
        return this.getMessages({ ...options, offset: 0 });
    }
    /**
     * Register a participant in the shared chat
     */
    async registerParticipant(options) {
        const { id, name, type = 'user', metadata } = options;
        this.participants.set(id, {
            id,
            name,
            type,
            metadata,
            lastActive: new Date().toISOString(),
            isActive: true,
        });
        // Broadcast participant joined event
        broadcast('shared-chat.participant-joined', { participant: this.participants.get(id) });
    }
    /**
     * Unregister a participant (marks them inactive)
     */
    async unregisterParticipant(participantId) {
        const participant = this.participants.get(participantId);
        if (participant) {
            participant.isActive = false;
            participant.lastActive = new Date().toISOString();
            this.participants.set(participantId, participant);
            broadcast('shared-chat.participant-left', { participant });
        }
    }
    /**
     * Get all registered participants
     */
    getParticipants() {
        return this.participants;
    }
    /**
     * Clean up old messages and inactive participants
     */
    cleanup() {
        const now = new Date();
        // Remove inactive participants (haven't been active in TTL window)
        for (const [id, participant] of this.participants.entries()) {
            if (!participant.isActive) {
                const lastActive = new Date(participant.lastActive);
                const hoursSinceActive = (now.getTime() - lastActive.getTime()) / 36e5; // hours
                if (hoursSinceActive > this.config.participantTtlMs / 36e5) {
                    this.participants.delete(id);
                    console.log();
                }
            }
        }
        // Optional: Clean up old messages based on age (keep last N days)
        const maxMessageAgeDays = 30;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - maxMessageAgeDays);
        this.messages = this.messages.filter(msg => {
            const msgDate = new Date(msg.timestamp);
            return msgDate > cutoffDate || msg.sequenceNumber > this.sequenceCounter - this.config.maxMessages;
        });
    }
    /**
     * Get statistics about the shared chat state
     */
    getStats() {
        return {
            totalMessages: this.messages.length,
            totalParticipants: this.participants.size,
            activeParticipants: [...this.participants.values()].filter(p => p.isActive).length,
            sequenceCounter: this.sequenceCounter,
            memoryUsageBytes: JSON.stringify({
                messages: this.messages.length * 500, // rough estimate
                participants: this.participants.size * 200,
            }),
        };
    }
}
// ── Singleton instance ──────────────────────────────────────────────
export const sharedChatService = new SharedChatService();
