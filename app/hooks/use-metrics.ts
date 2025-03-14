import { useState, useEffect, useRef } from 'react'
import type { JetstreamEvent } from '@/lib/playground/jetstream/types'

const RATE_WINDOW = 3000 // 3 second window for rate calculation
const UPDATE_INTERVAL = 500
const DECAY_FACTOR = 0.8 // Slightly faster decay
const MINIMUM_RATE = 0.5 // Stop decaying when we hit this threshold

export function useMetrics() {
  // Split the metrics into two states - one for totals and one for rates
  const [totals, setTotals] = useState({
    totalMessages: 0,
    messagesByCollection: {} as Record<string, number>,
    totalCreates: 0,
    totalDeletes: 0,
    totalNewAccounts: 0,
  })

  const [rates, setRates] = useState({
    messagesPerSecond: 0,
    createPerSecond: 0,
    deletePerSecond: 0,
    newAccountsPerSecond: 0,
    collectionRates: {} as Record<string, number>,
    lastUpdate: Date.now(),
  })

  // Keep track of recent messages for rate calculations
  const recentMessagesRef = useRef<{ timestamp: number; collection?: string; operation?: string }[]>([])

  // Handle new messages via callback
  const handleMessage = (message: JetstreamEvent) => {
    if (message.kind === 'commit') {
      const collection = message.commit.collection
      const operation = message.commit.operation
      const isNewAccount = operation === 'create' && collection === 'app.bsky.actor.profile'

      setTotals((prev) => ({
        totalMessages: prev.totalMessages + 1,
        messagesByCollection: {
          ...prev.messagesByCollection,
          [collection]: (prev.messagesByCollection[collection] || 0) + 1,
        },
        totalCreates: prev.totalCreates + (operation === 'create' ? 1 : 0),
        totalDeletes: prev.totalDeletes + (operation === 'delete' ? 1 : 0),
        totalNewAccounts: prev.totalNewAccounts + (isNewAccount ? 1 : 0),
      }))
    } else {
      setTotals((prev) => ({
        ...prev,
        totalMessages: prev.totalMessages + 1,
      }))
    }

    // Add to recent messages for rate calculation
    recentMessagesRef.current.push({
      timestamp: Date.now(),
      collection: message.kind === 'commit' ? message.commit.collection : undefined,
      operation: message.kind === 'commit' ? message.commit.operation : undefined,
    })
  }

  // Periodically update only the rates
  useEffect(() => {
    const updateRates = () => {
      const now = Date.now()
      const cutoff = now - RATE_WINDOW

      // Remove old messages
      recentMessagesRef.current = recentMessagesRef.current.filter((msg) => msg.timestamp > cutoff)

      setRates((prev) => {
        const windowSeconds = RATE_WINDOW / 1000

        // If no recent messages, decay the rates
        if (recentMessagesRef.current.length === 0) {
          // Check if any rates are still above our minimum threshold
          const hasNonZeroRates =
            prev.messagesPerSecond > MINIMUM_RATE ||
            prev.createPerSecond > MINIMUM_RATE ||
            prev.deletePerSecond > MINIMUM_RATE ||
            prev.newAccountsPerSecond > MINIMUM_RATE ||
            Object.values(prev.collectionRates).some((rate) => rate > MINIMUM_RATE)

          // If all rates are effectively zero, just return zeros
          if (!hasNonZeroRates) {
            return {
              messagesPerSecond: 0,
              createPerSecond: 0,
              deletePerSecond: 0,
              newAccountsPerSecond: 0,
              collectionRates: {},
              lastUpdate: now,
            }
          }

          // Otherwise continue decaying
          return {
            messagesPerSecond: Math.max(MINIMUM_RATE, prev.messagesPerSecond * DECAY_FACTOR),
            createPerSecond: Math.max(MINIMUM_RATE, prev.createPerSecond * DECAY_FACTOR),
            deletePerSecond: Math.max(MINIMUM_RATE, prev.deletePerSecond * DECAY_FACTOR),
            newAccountsPerSecond: Math.max(MINIMUM_RATE, prev.newAccountsPerSecond * DECAY_FACTOR),
            collectionRates: Object.fromEntries(
              Object.entries(prev.collectionRates)
                .map(([k, v]) => [k, Math.max(MINIMUM_RATE, v * DECAY_FACTOR)])
                .filter(([, v]) => typeof v === 'number' && v > MINIMUM_RATE) // Remove effectively zero rates
            ),
            lastUpdate: now,
          }
        }

        // Calculate new rates
        const messagesPerSecond = recentMessagesRef.current.length / windowSeconds

        // Calculate operation rates
        const recentCreates = recentMessagesRef.current.filter((m) => m.operation === 'create').length
        const recentDeletes = recentMessagesRef.current.filter((m) => m.operation === 'delete').length
        const recentNewAccounts = recentMessagesRef.current.filter(
          (m) => m.operation === 'create' && m.collection === 'app.bsky.actor.profile'
        ).length

        const createPerSecond = recentCreates / windowSeconds
        const deletePerSecond = recentDeletes / windowSeconds
        const newAccountsPerSecond = recentNewAccounts / windowSeconds

        // Calculate collection rates
        const collections = new Set(recentMessagesRef.current.map((m) => m.collection).filter(Boolean))
        const collectionRates: Record<string, number> = {}
        collections.forEach((collection) => {
          if (collection) {
            const count = recentMessagesRef.current.filter((m) => m.collection === collection).length
            collectionRates[collection] = count / windowSeconds
          }
        })

        return {
          messagesPerSecond,
          createPerSecond,
          deletePerSecond,
          newAccountsPerSecond,
          collectionRates,
          lastUpdate: now,
        }
      })
    }

    const interval = setInterval(updateRates, UPDATE_INTERVAL)
    return () => clearInterval(interval)
  }, [])

  // Combine the states for the return value
  return {
    metrics: {
      ...totals,
      ...rates,
    },
    onMessage: handleMessage,
  }
}
