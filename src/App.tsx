import { useEffect, useRef, useState } from 'react'

type Msg = { role: 'user' | 'assistant'; text: string }

// Milestone 1 shell: the conversation is the app.
// Real agent wiring (Supabase Edge Function + OpenRouter) lands in milestone 2.
export default function App() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      text: 'Hey. This is your kitchen taking shape. Tell me what you have, what you love, and what weeknights look like. The planning brain arrives next; nothing you say is lost.',
    },
  ])
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function send() {
    const text = draft.trim()
    if (!text) return
    setMessages((m) => [...m, { role: 'user', text }])
    setDraft('')
    // Placeholder until the chef brain lands: acknowledge, never pretend.
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: 'Noted and kept. The agent tools arrive in milestone 2, so I am listening but not planning yet.' },
      ])
    }, 450)
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Your kitchen</h1>
          <p className="tagline">talk it out. it plans itself.</p>
        </div>
      </header>

      <main className="thread">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </main>

      <footer className="composer">
        <textarea
          rows={1}
          value={draft}
          placeholder="What do you have? What sounds good?"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button aria-label="Send" onClick={send} disabled={!draft.trim()}>
          Send
        </button>
      </footer>
    </div>
  )
}
