import { useState, useEffect, useCallback } from 'react'
import { estimateTH3NetworkFee, generateTH3Address, sendTH3Transaction } from './lib/th3'
import * as bip39 from 'bip39'
import CryptoJS from 'crypto-js'
import { QRCode } from 'react-qr-code'
import './App.css'

const FALLBACK_TX_FEE_TH3 = 0.01
const EXPLORER_TX_BASE = 'https://explorer.th3chain.cloud/tx'
const WALLET_URL = 'https://wallet.th3chain.cloud/'

type WalletTransaction = {
  txid?: string
  type?: string
  amount?: number
  received?: number
  sentInput?: number
  sentToOthers?: number
  fee?: number
  change?: number
  confirmations?: number
  time?: number
}

function getPaymentRequest() {
  const params = new URLSearchParams(window.location.search)
  const send = (params.get('send') || '').trim()
  const amount = (params.get('amount') || '').trim()

  return {
    send: send.startsWith('TH3') ? send : '',
    amount: Number(amount) > 0 ? amount : ''
  }
}

function App() {
  const paymentRequest = getPaymentRequest()
  const [activeTab, setActiveTab] = useState(paymentRequest.send ? 'send' : 'wallet')
  const [address, setAddress] = useState(localStorage.getItem('th3_address') || '')
  const [balance, setBalance] = useState(0)
  const [txs, setTxs] = useState<WalletTransaction[]>([])
  const [password, setPassword] = useState('')
  const [tempSeed, setTempSeed] = useState('')
  const [seed, setSeed] = useState('')
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [view, setView] = useState<'login' | 'create-show' | 'import-input' | 'set-pass'>('login')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [sendTo, setSendTo] = useState(paymentRequest.send)
  const [sendAmount, setSendAmount] = useState(paymentRequest.amount)
  const [networkFee, setNetworkFee] = useState(FALLBACK_TX_FEE_TH3)
  const [isSending, setIsSending] = useState(false)
  const [isRefreshingAfterSend, setIsRefreshingAfterSend] = useState(false)
  const [isLoadingTxs, setIsLoadingTxs] = useState(false)
  const [lastTxid, setLastTxid] = useState('')
  const [addressCopied, setAddressCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteSlideProgress, setDeleteSlideProgress] = useState(0)
  const [showSeed, setShowSeed] = useState(false)

  const receiveLink = address
    ? `${WALLET_URL}?send=${encodeURIComponent(address)}`
    : ''

  const amount = Number(sendAmount)
  const txFee = Number.isFinite(networkFee) && networkFee > 0 ? networkFee : FALLBACK_TX_FEE_TH3
  const maxSend = Math.max(balance - txFee, 0)
  const totalSendCost = Number.isFinite(amount) && amount > 0 ? amount + txFee : txFee

  const shortAddress = (value: string) => value ? `${value.slice(0, 10)}...${value.slice(-8)}` : ''

  const formatTH3 = (value: number, maxDecimals = 8) => {
    const safeValue = Number.isFinite(value) ? value : 0

    return safeValue.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: maxDecimals
    })
  }

  const formatBalance = (value: number) => {
    const safeValue = Number.isFinite(value) ? value : 0
    const absoluteValue = Math.abs(safeValue)

    if (absoluteValue >= 100000) return formatTH3(safeValue, 2)
    if (absoluteValue >= 1000) return formatTH3(safeValue, 4)

    return formatTH3(safeValue)
  }

  const getBalanceValueClass = (value: string) => {
    if (value.length >= 18) return 'balance-value balance-value-xs'
    if (value.length >= 15) return 'balance-value balance-value-sm'
    if (value.length >= 12) return 'balance-value balance-value-md'

    return 'balance-value'
  }

  const shortHash = (value?: string) => {
    if (!value) return ''
    if (value.length <= 20) return value
    return `${value.slice(0, 12)}...${value.slice(-8)}`
  }

  const getTxInfoForAddress = (tx: WalletTransaction) => {
    const confirmations = Number(tx.confirmations || 0)
    const txType = tx.type || ''

    const directionMap: Record<string, string> = {
      sent: 'Sent',
      received: 'Received',
      mining: 'Mining Reward',
      immature_mining: 'Immature Mining Reward',
      self: 'Self Transfer',
      related: 'Related'
    }

    return {
      direction: directionMap[txType] || 'Related',
      displayAmount: Number(tx.amount || 0),
      received: Number(tx.received || 0),
      sent: Number(tx.sentInput || 0),
      sentToOthers: Number(tx.sentToOthers || 0),
      fee: Number(tx.fee || 0),
      change: Number(tx.change || 0),
      confirmations,
      isPositive: Number(tx.amount || 0) >= 0,
      isConfirmed: confirmations > 0,
      isMining: txType === 'mining' || txType === 'immature_mining',
      isMiningMature: txType === 'mining'
    }
  }

  const showErr = (msg: string) => {
    setError(msg)
    setTimeout(() => setError(''), 5000)
  }

  const showSuccess = (msg: string) => {
    setSuccess(msg)
    setTimeout(() => setSuccess(''), 8000)
  }

  const loadWallet = useCallback(async (silent = false) => {
    if (!address || !isUnlocked) return

    try {
      if (!silent) {
        setIsLoadingTxs(true)
      }

      const balanceRes = await fetch(
        `https://api.th3chain.cloud/api/address/${address}`
      )

      const balanceData = await balanceRes.json() as { balance?: number }
      setBalance(balanceData.balance || 0)

      const historyRes = await fetch(
        `https://api.th3chain.cloud/api/address/${address}/history?limit=50`
      )

      const historyData = await historyRes.json()

      if (Array.isArray(historyData)) {
        setTxs(historyData as WalletTransaction[])
      }
    } catch (e) {
      console.error(e)
    } finally {
      if (!silent) {
        setIsLoadingTxs(false)
      }
    }
  }, [address, isUnlocked])

  useEffect(() => {
    if (!address || !isUnlocked) return

    const initialLoad = window.setTimeout(() => {
      void loadWallet(false)
    }, 0)

    const interval = setInterval(
      () => loadWallet(true),
      10000
    )

    return () => {
      window.clearTimeout(initialLoad)
      clearInterval(interval)
    }
  }, [address, isUnlocked, loadWallet])

  const finalizeSetup = async () => {
    if (password.length < 6) {
      return showErr('Password min. 6 characters')
    }

    if (!tempSeed || tempSeed.split(' ').length < 12) {
      return showErr('Invalid seed phrase')
    }

    try {
      const enc = CryptoJS.AES.encrypt(tempSeed, password).toString()
      const addr = await generateTH3Address(tempSeed)

      localStorage.setItem('th3_encrypted_seed', enc)
      localStorage.setItem('th3_address', addr)

      setAddress(addr)
      setSeed(tempSeed)
      setError('')
      setSuccess('')
      setPassword('')
      setIsUnlocked(true)
    } catch {
      showErr('Wallet save failed')
    }
  }

  const unlockWallet = () => {
    const enc = localStorage.getItem('th3_encrypted_seed')

    try {
      const bytes = CryptoJS.AES.decrypt(enc!, password)
      const decrypted = bytes.toString(CryptoJS.enc.Utf8)

      if (decrypted) {
        setError('')
        setSuccess('')
        setIsUnlocked(true)
        setSeed(decrypted)
        setPassword('')
      } else {
        showErr('Wrong password')
      }
    } catch {
      showErr('Unlock failed')
    }
  }

  useEffect(() => {
    let cancelled = false

    const updateFee = async () => {
      if (!address || !isUnlocked || !Number.isFinite(amount) || amount <= 0) {
        setNetworkFee(FALLBACK_TX_FEE_TH3)
        return
      }

      try {
        const estimatedFee = await estimateTH3NetworkFee(address, amount)

        if (!cancelled) {
          setNetworkFee(estimatedFee)
        }
      } catch {
        if (!cancelled) {
          setNetworkFee(FALLBACK_TX_FEE_TH3)
        }
      }
    }

    updateFee()

    return () => {
      cancelled = true
    }
  }, [address, isUnlocked, amount])

  const useMaxAmount = () => {
    setSendAmount(maxSend.toFixed(8))
  }

  const sendTH3 = async () => {
    try {
      if (isSending) return

      if (!seed) {
        return showErr('Wallet is locked')
      }

      if (!sendTo.startsWith('TH3')) {
        return showErr('Invalid TH3 address')
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        return showErr('Invalid amount')
      }

      if (amount + txFee > balance) {
        return showErr(`Insufficient balance. Max send is ${formatTH3(maxSend)} TH3`)
      }

      setIsSending(true)
      setLastTxid('')

      const result = await sendTH3Transaction({
        seed,
        fromAddress: address,
        toAddress: sendTo,
        amount
      })

      setLastTxid(result.txid)
      setNetworkFee(result.fee)
      showSuccess(`Transaction sent: ${result.txid.slice(0, 12)}...${result.txid.slice(-8)}`)

      setSendTo('')
      setSendAmount('')

      await loadWallet(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed'

      if (message.includes('txn-mempool-conflict')) {
        showErr('Previous transaction is still pending. Please wait a moment and refresh your balance before sending again.')
        setIsRefreshingAfterSend(true)
        window.setTimeout(async () => {
          await loadWallet(true)
          setIsRefreshingAfterSend(false)
        }, 15000)
      } else if (message.includes('min relay fee not met')) {
        showErr('Network fee was too low for this transaction. Please refresh and try again.')
      } else {
        showErr(message)
      }
    } finally {
      setIsSending(false)
    }
  }

  const balanceDisplay = formatBalance(Number(balance))

  return (
    <div className={`app-wrapper ${isUnlocked ? "wallet-screen" : "setup-screen"}`}>
      <header className="wallet-brand-top">
        {isUnlocked && address ? (
          <div className="wallet-copy-bar">
            <span title={address}>{shortAddress(address)}</span>
            <button
              type="button"
              className={addressCopied ? 'copied' : ''}
              onClick={async () => {
                await navigator.clipboard.writeText(address)
                setAddressCopied(true)
                window.setTimeout(() => setAddressCopied(false), 1200)
              }}
            >
              {addressCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <>
            <div className="wallet-logo-link" aria-hidden="true">
              <img src="/th3-logo.png?v=3" alt="" />
            </div>
            <div>
              <h1>Wallet TH3</h1>
            </div>
          </>
        )}
      </header>

      {isUnlocked && (
        <div className="ig-stories" aria-label="Wallet quick actions">
          <button
            type="button"
            className={activeTab === 'wallet' ? 'active' : ''}
            onClick={() => setActiveTab('wallet')}
          >
            <span>
              <img src="/th3-logo.png?v=3" alt="" />
            </span>
            <strong>Balance</strong>
          </button>

          <button
            type="button"
            className={activeTab === 'send' ? 'active' : ''}
            onClick={() => setActiveTab('send')}
          >
            <span>↗</span>
            <strong>Send</strong>
          </button>

          <button
            type="button"
            className={activeTab === 'txs' ? 'active' : ''}
            onClick={() => setActiveTab('txs')}
          >
            <span>↺</span>
            <strong>History</strong>
          </button>

          <button
            type="button"
            className={activeTab === 'sec' ? 'active' : ''}
            onClick={() => setActiveTab('sec')}
          >
            <span>⌘</span>
            <strong>Vault</strong>
          </button>
        </div>
      )}

      <div className={`glass-box active-${activeTab}`}>
        {error && (
          <div className="error-msg">
            {error}
          </div>
        )}

        {!isUnlocked ? (
          <div className="setup-panel">
            {address ? (
              <>
                <input
                  type="password"
                  placeholder="Enter password"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') unlockWallet()
                  }}
                />
                <button onClick={unlockWallet}>
                  Unlock
                </button>
              </>
            ) : (
              <>
                {view === 'login' && (
                  <div className="setup-actions">
                    <button
                      className="primary-action"
                      onClick={() => {
                        setTempSeed(bip39.generateMnemonic())
                        setView('create-show')
                      }}
                    >
                      Create
                    </button>

                    <button
                      className="secondary-action"
                      onClick={() => setView('import-input')}
                    >
                      Import
                    </button>
                  </div>
                )}

                {view === 'create-show' && (
                  <>
                    <p className="label">
                      Save your seed phrase:
                    </p>

                    <div className="seed-box">
                      {tempSeed}
                    </div>

                    <button
                      className="primary-action"
                      onClick={() => setView('set-pass')}
                    >
                      Saved
                    </button>
                  </>
                )}

                {view === 'import-input' && (
                  <>
                    <input
                      type="text"
                      placeholder="Paste seed phrase"
                      onChange={(e) => setTempSeed(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          if (!tempSeed) return showErr('Enter seed phrase')
                          setView('set-pass')
                        }
                      }}
                    />

                    <button
                      className="primary-action"
                      onClick={() => {
                        if (!tempSeed) return showErr('Enter seed phrase')
                        setView('set-pass')
                      }}
                    >
                      Next
                    </button>
                  </>
                )}

                {view === 'set-pass' && (
                  <>
                    <input
                      type="password"
                      placeholder="Set password"
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finalizeSetup()
                      }}
                    />

                    <button className="primary-action" onClick={finalizeSetup}>
                      Confirm
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          <main className="view-surface wallet-content">


            {activeTab === 'wallet' && (
              <section className="wallet-panel">
                <div className="balance-card">
                  <div className="balance-label">
                    Available Balance
                  </div>

                  <div className={getBalanceValueClass(balanceDisplay)}>
                    {balanceDisplay}
                  </div>

                  <div className="balance-unit">
                    TH3
                  </div>
                </div>

                <div className="wallet-address">
                  <div className="wallet-address-label">
                    Receive
                  </div>

                  <div className="qr-stage">
                    <div className="qr-card">
                      <QRCode
                        value={receiveLink || address}
                        size={150}
                      />
                    </div>
                  </div>

                  <p className="helper-copy">
                    Scan to open TH3 Wallet with this address prepared in Send.
                  </p>

                </div>
              </section>
            )}

            {activeTab === 'send' && (
              <section className="send-panel">
                {success && (
                  <div className="send-success-msg">
                    <span>{success}</span>
                    {lastTxid && (
                      <a
                        href={`${EXPLORER_TX_BASE}/${lastTxid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View transaction
                      </a>
                    )}
                  </div>
                )}

                <input
                  type="text"
                  placeholder="Recipient Address"
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                />

                <input
                  type="number"
                  placeholder="Amount TH3"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                />

                <button
                  type="button"
                  className="secondary-action max-action"
                  onClick={useMaxAmount}
                  disabled={maxSend <= 0 || isSending}
                >
                  Max {formatTH3(maxSend)} TH3
                </button>

                <button
                  className="primary-action send-action"
                  disabled={balance <= 0 || isSending || isRefreshingAfterSend}
                  onClick={sendTH3}
                >
                  {isSending ? 'Sending...' : isRefreshingAfterSend ? 'Refreshing wallet...' : 'Send TH3'}
                </button>

                <div className="send-summary">
                  <div>
                    <span>Available</span>
                    <strong>{formatTH3(Number(balance))} TH3</strong>
                  </div>
                  <div>
                    <span>Network fee</span>
                    <strong>{formatTH3(txFee)} TH3</strong>
                  </div>
                  <div>
                    <span>Total</span>
                    <strong>{formatTH3(totalSendCost)} TH3</strong>
                  </div>
                </div>

                {balance <= 0 && (
                  <div className="helper-copy helper-card">
                    Mining rewards are maturing.
                  </div>
                )}
              </section>
            )}

            {activeTab === 'txs' && (
              <section className="history-panel scroll-area">
                {isLoadingTxs ? (
                  <div className="tx-item">
                    Loading transactions...
                  </div>
                ) : txs.length === 0 ? (
                  <div className="tx-item">
                    No transactions yet
                  </div>
                ) : (
                  txs.map((tx, i) => {
                    const txInfo = getTxInfoForAddress(tx)

                    return (
                      <div
                        key={tx.txid || i}
                        className={`tx-item tx-item-modern ${txInfo.isPositive ? 'tx-positive' : 'tx-negative'}`}
                      >
                        <div className="tx-main-row">
                          <div>
                            <div className="tx-type">
                              {txInfo.direction}
                            </div>

                            <div className="tx-date">
                              {tx.time ? new Date(tx.time * 1000).toLocaleString() : 'Pending'}
                            </div>
                          </div>

                          <div className="tx-amount">
                            {txInfo.isPositive ? '+' : '-'}
                            {formatTH3(Math.abs(txInfo.displayAmount))} TH3
                          </div>
                        </div>

                        <div className="tx-meta-row">
                          <span className={txInfo.isConfirmed ? 'tx-confirmed' : 'tx-pending'}>
                            {txInfo.isConfirmed ? 'Confirmed' : 'Pending'}
                          </span>

                          <span>
                            {txInfo.confirmations} confirmations
                          </span>

                          {txInfo.isMining && !txInfo.isMiningMature && (
                            <span>
                              Matures at 100 confirmations
                            </span>
                          )}

                          {txInfo.fee > 0 && (
                            <span>
                              Fee {formatTH3(txInfo.fee)} TH3
                            </span>
                          )}

                          {txInfo.change > 0 && txInfo.direction === 'Sent' && (
                            <span>
                              Change {formatTH3(txInfo.change)} TH3
                            </span>
                          )}
                        </div>

                        <div className="tx-hash">
                          {shortHash(tx.txid)}
                        </div>

                        <div className="tx-actions">
                          <a
                            href={`${EXPLORER_TX_BASE}/${tx.txid}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View transaction
                          </a>
                        </div>
                      </div>
                    )
                  })
                )}
              </section>
            )}

            {activeTab === 'sec' && (
              <section className="security-panel">
                {!showSeed ? (
                  <div className="security-card">
                    <div>
                      <span className="panel-eyebrow">Private recovery</span>
                      <h2>Seed phrase</h2>
                      <p>Reveal it only in a private place. Anyone with this phrase can control the wallet.</p>
                    </div>
                    <button className="primary-action" onClick={() => setShowSeed(true)}>
                    Reveal Seed Phrase
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="seed-box">
                      {seed}
                    </div>

                    <button className="secondary-action" onClick={() => setShowSeed(false)}>
                      Hide Seed Phrase
                    </button>
                  </>
                )}

                <button
                  className="danger-action reset-btn"
                  onClick={() => {
                    setDeleteSlideProgress(0)
                    setConfirmDelete(true)
                  }}
                >
                  Delete Wallet
                </button>
              </section>
            )}
          </main>
        )}
      </div>

      {confirmDelete && (
        <div
          className="delete-modal-backdrop"
          onMouseDown={() => {
            setDeleteSlideProgress(0)
            setConfirmDelete(false)
          }}
        >
          <div className="delete-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Delete wallet?</h2>
            <p>
              This removes the wallet from this browser only. Slide all the way right to unlock delete.
            </p>
            <div className={`delete-slide-shell ${deleteSlideProgress >= 100 ? 'unlocked' : ''}`}>
              <div className="delete-slide-fill" style={{ width: `${deleteSlideProgress}%` }} />
              <div className="delete-slide-label">
                {deleteSlideProgress >= 100 ? 'Unlocked' : 'Slide to confirm'}
              </div>
              <input
                className="delete-slide-range"
                type="range"
                min="0"
                max="100"
                value={deleteSlideProgress}
                onMouseDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const startX = e.clientX - rect.left
                  if (startX > 34) {
                    e.preventDefault()
                  }
                }}
                onChange={(e) => setDeleteSlideProgress(Number(e.target.value))}
              />
            </div>

            <div className="delete-confirm-actions">
              <button
                type="button"
                className="delete-cancel-btn"
                onClick={() => {
                  setDeleteSlideProgress(0)
                  setConfirmDelete(false)
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                className="delete-confirm-btn"
                disabled={deleteSlideProgress < 100}
                onClick={() => {
                  if (deleteSlideProgress < 100) return
                  localStorage.clear()
                  window.location.reload()
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <aside className="wallet-side-rail" aria-label="TH3 quick links">
        <a href="https://th3chain.cloud" target="_blank" rel="noreferrer" aria-label="Main page">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 3.2 3 10.6l1.28 1.54L5.5 11.13V20h5.25v-5.5h2.5V20h5.25v-8.87l1.22 1.01L21 10.6 12 3.2Zm4.5 14.8h-1.25v-5.5h-6.5V18H7.5v-8.52L12 5.78l4.5 3.7V18Z" />
            </svg>
          </span>
          <span className="rail-label">Main Page</span>
        </a>

        <a href="https://x.com/TH3ChainCloud" target="_blank" rel="noreferrer" aria-label="Twitter">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M17.53 3h3.02l-6.6 7.55L21.7 21h-6.08l-4.76-6.22L5.42 21H2.38l7.06-8.07L2 3h6.23l4.3 5.69L17.53 3Zm-1.06 16.16h1.67L7.32 4.74H5.53l10.94 14.42Z" />
            </svg>
          </span>
          <span className="rail-label">Twitter</span>
        </a>

        <a href="https://th3chain.cloud" target="_blank" rel="noreferrer" aria-label="Web">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.93 9h-3.18a15.9 15.9 0 0 0-1.2-5.02A8.03 8.03 0 0 1 18.93 11ZM12 4.04c.66.95 1.45 3.04 1.7 6.96h-3.4c.25-3.92 1.04-6.01 1.7-6.96ZM4.26 13h3.99c.12 2.03.43 3.79.88 5.06A8.02 8.02 0 0 1 4.26 13Zm3.99-2H4.26a8.02 8.02 0 0 1 4.87-5.06A17.5 17.5 0 0 0 8.25 11ZM12 19.96c-.66-.95-1.45-3.04-1.7-6.96h3.4c-.25 3.92-1.04 6.01-1.7 6.96Zm2.87-1.9c.45-1.27.76-3.03.88-5.06h3.18a8.03 8.03 0 0 1-4.06 5.06Z" />
            </svg>
          </span>
          <span className="rail-label">Web</span>
        </a>

        <a href="https://chromewebstore.google.com/" target="_blank" rel="noreferrer" aria-label="Chrome">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 2.5L4.3 3.66A9.96 9.96 0 0 1 12 2Zm0 20a10 10 0 0 1-8.66-15l4.33 7.5A5 5 0 0 0 12 17h6.74A9.98 9.98 0 0 1 12 22Zm8.66-13A10 10 0 0 1 20 18h-8a5 5 0 0 0 4.33-7.5L15.46 9h5.2ZM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />
            </svg>
          </span>
          <span className="rail-label">Chrome</span>
        </a>

        <a href="https://t.me/TH3ChainCloud" target="_blank" rel="noreferrer" aria-label="Telegram">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M21.78 4.36 18.5 19.82c-.25 1.1-.9 1.36-1.82.85l-5.02-3.7-2.42 2.33c-.27.27-.5.5-1.03.5l.37-5.1 9.28-8.39c.4-.36-.09-.56-.62-.2L5.77 13.34.83 11.8c-1.07-.34-1.09-1.07.22-1.58L20.4 2.76c.9-.33 1.68.2 1.38 1.6Z" />
            </svg>
          </span>
          <span className="rail-label">Telegram</span>
        </a>

        <a href="mailto:contact@th3chain.cloud" aria-label="Contact">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M4.5 5.5h15A2.5 2.5 0 0 1 22 8v8a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 16V8a2.5 2.5 0 0 1 2.5-2.5Zm0 2 7.5 5.05L19.5 7.5h-15Zm15 9A.5.5 0 0 0 20 16V9.28l-7.44 5.02a1 1 0 0 1-1.12 0L4 9.28V16a.5.5 0 0 0 .5.5h15Z" />
            </svg>
          </span>
          <span className="rail-label">Contact</span>
        </a>
      </aside>

    </div>
  )
}

export default App
