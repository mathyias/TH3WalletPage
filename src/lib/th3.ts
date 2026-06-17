import * as bip39 from 'bip39'
import { HDKey } from '@scure/bip32'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import * as secp from '@noble/secp256k1'
import bs58check from 'bs58check'

const API_BASE = 'https://api.th3chain.cloud/api'

const TH3_PUBKEY_PREFIX = new Uint8Array([0xc2, 0x6a, 0xe5])
const TH3_WIF_PREFIX = 128
const TH3_DERIVATION_PATH = "m/44'/175'/0'/0/0"

const COIN = 100000000
const SIGHASH_ALL = 0x01

const MIN_RELAY_FEE_SATS_PER_KB = 1000000
const FEE_SAFETY_MULTIPLIER = 2
const MIN_FEE_SATS = 1000000
const DUST_SATS = 1000

type TH3Utxo = {
  txid: string
  vout: number
  satoshis: number
  amount: number
  scriptPubKey: string
  confirmations: number
}

type SendTH3Params = {
  seed: string
  fromAddress: string
  toAddress: string
  amount: number
}

type SendTH3Result = {
  txid: string
  rawTx: string
  fee: number
}

function asBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data)
}

function hash160(data: Uint8Array): Uint8Array {
  return asBytes(ripemd160(sha256(data)))
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return asBytes(sha256(sha256(data)))
}

function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid hex')
  }

  const out = new Uint8Array(hex.length / 2)

  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }

  return out
}

function reverseBytes(data: Uint8Array): Uint8Array {
  return Uint8Array.from(data).reverse()
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)

  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

function u32LE(value: number): Uint8Array {
  const out = new Uint8Array(4)
  const view = new DataView(out.buffer)

  view.setUint32(0, value, true)

  return out
}

function u64LE(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid satoshi amount')
  }

  let n = BigInt(value)
  const out = new Uint8Array(8)

  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }

  return out
}

function varInt(value: number): Uint8Array {
  if (value < 0xfd) {
    return Uint8Array.from([value])
  }

  if (value <= 0xffff) {
    return Uint8Array.from([
      0xfd,
      value & 0xff,
      (value >> 8) & 0xff
    ])
  }

  return Uint8Array.from([
    0xfe,
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff
  ])
}

function encodePush(data: Uint8Array): Uint8Array {
  if (data.length >= 0x4c) {
    throw new Error('Pushdata too long')
  }

  return concatBytes([
    Uint8Array.from([data.length]),
    data
  ])
}

function derEncodeSignature(signature: Uint8Array): Uint8Array {
  const r = asBytes(signature.slice(0, 32))
  const s = asBytes(signature.slice(32, 64))

  const encodeInt = (value: Uint8Array): Uint8Array => {
    let start = 0

    while (start < value.length - 1 && value[start] === 0) {
      start++
    }

    let out = asBytes(value.slice(start))

    if (out[0] & 0x80) {
      out = concatBytes([Uint8Array.from([0]), out])
    }

    return concatBytes([
      Uint8Array.from([0x02, out.length]),
      out
    ])
  }

  const rDer = encodeInt(r)
  const sDer = encodeInt(s)
  const body = concatBytes([rDer, sDer])

  return concatBytes([
    Uint8Array.from([0x30, body.length]),
    body
  ])
}

function addressToPubKeyHash(address: string): Uint8Array {
  const decoded = bs58check.decode(address)
  const payload = asBytes(decoded)

  if (payload.length !== TH3_PUBKEY_PREFIX.length + 20) {
    throw new Error('Invalid TH3 address')
  }

  for (let i = 0; i < TH3_PUBKEY_PREFIX.length; i++) {
    if (payload[i] !== TH3_PUBKEY_PREFIX[i]) {
      throw new Error('Invalid TH3 address')
    }
  }

  return payload.slice(TH3_PUBKEY_PREFIX.length)
}

function p2pkhScriptFromAddress(address: string): Uint8Array {
  const pubKeyHash = addressToPubKeyHash(address)

  return concatBytes([
    Uint8Array.from([0x76, 0xa9, 0x14]),
    pubKeyHash,
    Uint8Array.from([0x88, 0xac])
  ])
}

function scriptSig(signature: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const signatureWithHashType = concatBytes([
    signature,
    Uint8Array.from([SIGHASH_ALL])
  ])

  return concatBytes([
    encodePush(signatureWithHashType),
    encodePush(publicKey)
  ])
}

function amountToSats(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid amount')
  }

  return Math.round(amount * COIN)
}

async function deriveTH3Child(mnemonic: string): Promise<HDKey> {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid seed phrase')
  }

  const seed = await bip39.mnemonicToSeed(mnemonic)
  const master = HDKey.fromMasterSeed(seed)

  return master.derive(TH3_DERIVATION_PATH)
}

async function fetchUtxos(address: string): Promise<TH3Utxo[]> {
  const response = await fetch(`${API_BASE}/address/${address}/utxos`)
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load UTXO')
  }

  if (!Array.isArray(data)) {
    throw new Error('Invalid UTXO response')
  }

  return data.filter((utxo) => utxo.confirmations > 0)
}

function estimateP2pkhTxBytes(inputCount: number, outputCount: number): number {
  // P2PKH input is ~148 bytes, output is ~34 bytes, plus version/locktime/varints.
  return 10 + inputCount * 148 + outputCount * 34
}

function calculateFeeSats(inputCount: number, outputCount: number): number {
  const estimatedBytes = estimateP2pkhTxBytes(inputCount, outputCount)
  const relayFee = Math.ceil(
    estimatedBytes * MIN_RELAY_FEE_SATS_PER_KB / 1000
  )
  const safeFee = Math.ceil(relayFee * FEE_SAFETY_MULTIPLIER)

  return Math.max(MIN_FEE_SATS, safeFee)
}

function selectUtxosForAmount(utxos: TH3Utxo[], amountSats: number): {
  selected: TH3Utxo[]
  feeSats: number
} {
  const selected: TH3Utxo[] = []
  let selectedTotal = 0
  let feeSats: number

  for (const utxo of utxos) {
    selected.push(utxo)
    selectedTotal += utxo.satoshis

    const outputCountWithChange = 2
    feeSats = calculateFeeSats(selected.length, outputCountWithChange)

    if (selectedTotal >= amountSats + feeSats) {
      const change = selectedTotal - amountSats - feeSats

      if (change > DUST_SATS) {
        return { selected, feeSats }
      }

      const feeWithoutChange = calculateFeeSats(selected.length, 1)

      if (selectedTotal >= amountSats + feeWithoutChange) {
        return { selected, feeSats: feeWithoutChange }
      }
    }
  }

  throw new Error('Insufficient balance including fee')
}

export async function estimateTH3NetworkFee(
  fromAddress: string,
  amount: number
): Promise<number> {
  addressToPubKeyHash(fromAddress)

  const amountSats = amountToSats(amount)
  const utxos = await fetchUtxos(fromAddress)

  if (utxos.length === 0) {
    return MIN_FEE_SATS / COIN
  }

  const { feeSats } = selectUtxosForAmount(utxos, amountSats)

  return feeSats / COIN
}

async function broadcastRawTx(rawTx: string): Promise<string> {
  const response = await fetch(`${API_BASE}/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ rawTx })
  })

  const data = await response.json()

  if (!response.ok || data.error) {
    throw new Error(data.error || 'Broadcast failed')
  }

  return data.txid
}

function serializeTx(
  inputs: {
    txid: string
    vout: number
    script: Uint8Array
    sequence: number
  }[],
  outputs: {
    value: number
    script: Uint8Array
  }[],
  locktime = 0
): Uint8Array {
  const parts: Uint8Array[] = []

  parts.push(u32LE(2))
  parts.push(varInt(inputs.length))

  for (const input of inputs) {
    parts.push(reverseBytes(fromHex(input.txid)))
    parts.push(u32LE(input.vout))
    parts.push(varInt(input.script.length))
    parts.push(input.script)
    parts.push(u32LE(input.sequence))
  }

  parts.push(varInt(outputs.length))

  for (const output of outputs) {
    parts.push(u64LE(output.value))
    parts.push(varInt(output.script.length))
    parts.push(output.script)
  }

  parts.push(u32LE(locktime))

  return concatBytes(parts)
}

function signatureHash(
  utxos: TH3Utxo[],
  outputs: {
    value: number
    script: Uint8Array
  }[],
  inputIndex: number
): Uint8Array {
  const signingInputs = utxos.map((utxo, index) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    script: index === inputIndex ? fromHex(utxo.scriptPubKey) : new Uint8Array(),
    sequence: 0xffffffff
  }))

  const txForSig = serializeTx(signingInputs, outputs)

  return doubleSha256(
    concatBytes([
      txForSig,
      u32LE(SIGHASH_ALL)
    ])
  )
}

async function buildSignedTransaction(params: {
  utxos: TH3Utxo[]
  privateKey: Uint8Array
  publicKey: Uint8Array
  toAddress: string
  fromAddress: string
  amountSats: number
  feeSats: number
}): Promise<string> {
  const {
    utxos,
    privateKey,
    publicKey,
    toAddress,
    fromAddress,
    amountSats,
    feeSats
  } = params

  const totalIn = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)
  const change = totalIn - amountSats - feeSats

  if (change < 0) {
    throw new Error('Insufficient balance')
  }

  const outputs = [
    {
      value: amountSats,
      script: p2pkhScriptFromAddress(toAddress)
    }
  ]

  if (change > DUST_SATS) {
    outputs.push({
      value: change,
      script: p2pkhScriptFromAddress(fromAddress)
    })
  }

  const signedInputs: {
    txid: string
    vout: number
    script: Uint8Array
    sequence: number
  }[] = []

  for (let inputIndex = 0; inputIndex < utxos.length; inputIndex++) {
    const utxo = utxos[inputIndex]
    const hash = signatureHash(utxos, outputs, inputIndex)

    const sig = await secp.signAsync(hash, privateKey, {
      prehash: false,
      lowS: true,
      format: 'compact'
    })

    const derSig = derEncodeSignature(asBytes(sig))

    signedInputs.push({
      txid: utxo.txid,
      vout: utxo.vout,
      script: scriptSig(derSig, publicKey),
      sequence: 0xffffffff
    })
  }

  return toHex(serializeTx(signedInputs, outputs))
}

export async function generateTH3Address(
  mnemonic: string
): Promise<string> {
  const child = await deriveTH3Child(mnemonic)

  if (!child.publicKey) {
    throw new Error('No public key')
  }

  const pubKeyHash = hash160(child.publicKey)
  const payload = new Uint8Array(TH3_PUBKEY_PREFIX.length + pubKeyHash.length)

  payload.set(TH3_PUBKEY_PREFIX, 0)
  payload.set(pubKeyHash, TH3_PUBKEY_PREFIX.length)

  return bs58check.encode(payload)
}

export async function getTH3PrivateKey(
  mnemonic: string
): Promise<Uint8Array> {
  const child = await deriveTH3Child(mnemonic)

  if (!child.privateKey) {
    throw new Error('No private key')
  }

  return asBytes(child.privateKey)
}

export async function getTH3WIF(
  mnemonic: string
): Promise<string> {
  const privateKey = await getTH3PrivateKey(mnemonic)

  const payload = new Uint8Array(34)
  payload[0] = TH3_WIF_PREFIX
  payload.set(privateKey, 1)
  payload[33] = 0x01

  return bs58check.encode(payload)
}

export async function sendTH3Transaction({
  seed,
  fromAddress,
  toAddress,
  amount
}: SendTH3Params): Promise<SendTH3Result> {
  addressToPubKeyHash(fromAddress)
  addressToPubKeyHash(toAddress)

  const child = await deriveTH3Child(seed)

  if (!child.privateKey || !child.publicKey) {
    throw new Error('Missing wallet key')
  }

  const privateKey = asBytes(child.privateKey)
  const publicKey = asBytes(child.publicKey)

  const derivedAddress = await generateTH3Address(seed)

  if (derivedAddress !== fromAddress) {
    throw new Error('Wallet seed does not match sender address')
  }

  const amountSats = amountToSats(amount)
  const utxos = await fetchUtxos(fromAddress)

  if (utxos.length === 0) {
    throw new Error('No spendable UTXO')
  }

  const { selected, feeSats } = selectUtxosForAmount(utxos, amountSats)

  const rawTx = await buildSignedTransaction({
    utxos: selected,
    privateKey,
    publicKey,
    toAddress,
    fromAddress,
    amountSats,
    feeSats
  })

  const txid = await broadcastRawTx(rawTx)

  return {
    txid,
    rawTx,
    fee: feeSats / COIN
  }
}
