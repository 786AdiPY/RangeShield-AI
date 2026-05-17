'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Mic, MicOff, Loader2 } from 'lucide-react';

// Action keywords that require confirmation before acting
const ACTION_KEYWORDS = ['reroute', 're-route', 'charging station', 'find charger', 'navigate to', 'take me to', 'stop at'];

function detectAction(text: string): string | null {
    const lower = text.toLowerCase();
    if (lower.includes('reroute') || lower.includes('re-route')) return 'reroute';
    if (lower.includes('charging station') || lower.includes('find charger') || lower.includes('charger')) return 'charger';
    if (lower.includes('navigate to') || lower.includes('take me to') || lower.includes('stop at')) return 'navigate';
    return null;
}

function speak(text: string) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const doSpeak = () => {
        window.speechSynthesis.cancel();
        // Chrome pauses speechSynthesis when tab backgrounds — resume first
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();

        const utterance  = new SpeechSynthesisUtterance(text);
        utterance.rate   = 0.92;
        utterance.pitch  = 1.0;
        utterance.volume = 1.0;

        // Pick best English voice
        const voices    = window.speechSynthesis.getVoices();
        const preferred = voices.find(v => v.lang === 'en-US' && v.localService)
            ?? voices.find(v => v.lang.startsWith('en'));
        if (preferred) utterance.voice = preferred;

        utterance.onerror = (e) => console.warn('[TTS] error:', e.error);
        window.speechSynthesis.speak(utterance);
    };

    // Defer by one tick — Chrome blocks speak() called inside Promise chains
    setTimeout(doSpeak, 50);
}

interface VoiceMicrophoneProps {
    onResponse: (response: string, isImportant: boolean) => void;
    onTranscript?: (text: string) => void;
    context?: {
        telemetry: {
            soc: number;
            efficiency: number;
            temp: number;
            tirePressure: number;
        };
        trip?: {
            origin?: string;
            destination?: string;
            distance_km?: number;
            duration_mins?: number;
            battery_pct?: number;
            cargo_kg?: number;
            passengers?: number;
        };
    };
}

export default function VoiceMicrophone({ onResponse, onTranscript, context }: VoiceMicrophoneProps) {
    const [isListening, setIsListening]         = useState(false);
    const [isProcessing, setIsProcessing]       = useState(false);
    const [transcript, setTranscript]           = useState('');
    const [recognition, setRecognition]         = useState<SpeechRecognition | null>(null);
    const [pendingAction, setPendingAction]     = useState<{ type: string; question: string } | null>(null);
    const ttsUnlockedRef                        = useRef(false);

    // Initialize Speech Recognition
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (SpeechRecognition) {
                const recognitionInstance = new SpeechRecognition();
                recognitionInstance.continuous = false;
                recognitionInstance.interimResults = true;
                recognitionInstance.lang = 'en-US';

                recognitionInstance.onresult = (event) => {
                    const current = event.resultIndex;
                    const result = event.results[current];
                    const transcriptText = result[0].transcript;
                    setTranscript(transcriptText);

                    if (result.isFinal) {
                        handleVoiceInput(transcriptText);
                    }
                };

                recognitionInstance.onend = () => {
                    setIsListening(false);
                };

                recognitionInstance.onerror = (event) => {
                    console.error('Speech recognition error:', event.error);
                    setIsListening(false);
                };

                setRecognition(recognitionInstance);
            }
        }
    }, []);

    const handleVoiceInput = useCallback(async (voiceText: string) => {
        if (!voiceText.trim()) return;
        const lower = voiceText.toLowerCase().trim();

        // ── Confirmation reply handling ──────────────────────────────────────
        if (pendingAction) {
            const confirmed = lower.includes('yes') || lower.includes('yeah') || lower.includes('okay') || lower.includes('ok') || lower.includes('sure') || lower.includes('go ahead');
            const denied    = lower.includes('no') || lower.includes('nope') || lower.includes('cancel') || lower.includes('stop');

            if (confirmed) {
                const msg = pendingAction.type === 'charger'
                    ? "Looking for the nearest charging station along your route. I'll update you shortly."
                    : pendingAction.type === 'reroute'
                    ? "Recalculating the most efficient route for your current battery level."
                    : "Got it, navigating now.";
                setPendingAction(null);
                speak(msg);
                onResponse(msg, false);
            } else if (denied) {
                const msg = "No problem, staying on the current route.";
                setPendingAction(null);
                speak(msg);
                onResponse(msg, false);
            } else {
                speak("Sorry, I didn't catch that. Say yes to confirm or no to cancel.");
            }
            return;
        }

        setIsProcessing(true);
        setTranscript('');
        onTranscript?.(voiceText);

        try {
            const apiContext = context ? {
                telemetry: {
                    soc:         context.telemetry.soc,
                    arrival_soc: context.telemetry.soc,
                    efficiency:  context.telemetry.efficiency > 2
                        ? context.telemetry.efficiency / 1000   // Wh/km → kWh/km
                        : context.telemetry.efficiency,
                    temp:        context.telemetry.temp,
                    range_km:    null,                           // live trip — unknown ahead
                },
                trip: {
                    origin:       context.trip?.origin       ?? '',
                    destination:  context.trip?.destination  ?? '',
                    distance_km:  context.trip?.distance_km  ?? 0,
                    duration_mins: context.trip?.duration_mins ?? 0,
                    battery_pct:  context.trip?.battery_pct  ?? context.telemetry.soc,
                    battery_kwh:  null,
                    tire_psi:     context.telemetry.tirePressure,
                    cargo_kg:     context.trip?.cargo_kg     ?? 0,
                    passengers:   context.trip?.passengers   ?? 1,
                },
                user:     { passengers: context.trip?.passengers ?? 1, payload: context.trip?.cargo_kg ?? 0 },
                chargers: [],
            } : null;

            const res = await fetch('/api/copilot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: voiceText }],
                    context: apiContext
                })
            });

            const data = await res.json();
            if (data.reply) {
                const isImportant = data.reply.toLowerCase().includes('critical') ||
                    data.reply.toLowerCase().includes('alert') ||
                    data.reply.toLowerCase().includes('warning');

                // Detect if response implies an action — ask for confirmation first
                const actionType = detectAction(voiceText) || detectAction(data.reply);
                if (actionType) {
                    const questions: Record<string, string> = {
                        charger:  "Should I find the nearest charging station along your route? Say yes or no.",
                        reroute:  "Should I reroute to a more efficient path for your current battery level? Say yes or no.",
                        navigate: "Should I navigate to that location? Say yes or no.",
                    };
                    const question = questions[actionType] ?? "Should I go ahead with that? Say yes or no.";
                    setPendingAction({ type: actionType, question });
                    speak(data.reply + ' ' + question);
                    onResponse(data.reply + '\n\n' + question, isImportant);
                } else {
                    speak(data.reply);
                    onResponse(data.reply, isImportant);
                }
            } else {
                onResponse('Unable to process request. Please try again.', false);
            }
        } catch (error) {
            console.error('Voice AI Error:', error);
            onResponse('Connection error. Please try again.', true);
        } finally {
            setIsProcessing(false);
        }
    }, [context, onResponse]);

    const toggleListening = () => {
        if (!recognition) {
            alert('Speech recognition is not supported in this browser.');
            return;
        }

        // Unlock TTS on every tap (Chrome resets after tab switch / idle)
        if ('speechSynthesis' in window) {
            if (window.speechSynthesis.paused) window.speechSynthesis.resume();
            if (!ttsUnlockedRef.current) {
                ttsUnlockedRef.current = true;
                // Silent utterance to unlock audio context in user-gesture handler
                const unlock = new SpeechSynthesisUtterance('​');
                unlock.volume = 0;
                window.speechSynthesis.speak(unlock);
            }
            // Pre-load voices list
            window.speechSynthesis.getVoices();
        }

        if (isListening) {
            recognition.stop();
            setIsListening(false);
        } else {
            setTranscript('');
            recognition.start();
            setIsListening(true);
        }
    };

    // Left side waves (5 bars)
    const leftWaves = [
        { delay: 0, height: 60, duration: 1.2 },
        { delay: 0.1, height: 80, duration: 1.4 },
        { delay: 0.2, height: 100, duration: 1.1 },
        { delay: 0.15, height: 70, duration: 1.3 },
        { delay: 0.05, height: 50, duration: 1.5 },
    ];

    // Right side waves (5 bars, mirrored)
    const rightWaves = [
        { delay: 0.05, height: 50, duration: 1.5 },
        { delay: 0.15, height: 70, duration: 1.3 },
        { delay: 0.2, height: 100, duration: 1.1 },
        { delay: 0.1, height: 80, duration: 1.4 },
        { delay: 0, height: 60, duration: 1.2 },
    ];

    return (
        <div className="flex flex-col items-center gap-4">
            {/* Pending action confirmation prompt */}
            {pendingAction && (
                <div className="text-xs text-cyan-300 text-center max-w-[240px] bg-cyan-950/40 border border-cyan-700/50 rounded-lg px-3 py-2 animate-pulse">
                    {pendingAction.question}
                </div>
            )}

            {/* Transcript Display */}
            {transcript && !pendingAction && (
                <div className="text-xs text-zinc-400 italic text-center max-w-[200px] truncate">
                    "{transcript}"
                </div>
            )}

            <div className="flex items-center gap-6">
                {/* Left Waves - Only show when listening */}
                <div className="flex items-center gap-1.5">
                    {leftWaves.map((wave, index) => (
                        <motion.div
                            key={`left-${index}`}
                            className="w-1 bg-gradient-to-t from-cyan-500 to-cyan-300 rounded-full"
                            animate={isListening ? {
                                height: [wave.height * 0.3, wave.height * 0.7, wave.height * 0.3],
                            } : { height: 20 }}
                            transition={{
                                duration: wave.duration,
                                repeat: Infinity,
                                delay: wave.delay,
                                ease: "easeInOut",
                            }}
                            style={{
                                transformOrigin: "center",
                                opacity: isListening ? 1 : 0.3,
                            }}
                        />
                    ))}
                </div>

                {/* Microphone Button */}
                <button
                    onClick={toggleListening}
                    disabled={isProcessing}
                    className="relative"
                >
                    {/* Outer glow circle */}
                    <motion.div
                        className={`absolute inset-0 rounded-full blur-xl ${isListening ? 'bg-gradient-to-br from-cyan-500/40 to-blue-500/40' : 'bg-gradient-to-br from-cyan-500/20 to-blue-500/20'
                            }`}
                        animate={isListening ? {
                            scale: [1, 1.3, 1],
                            opacity: [0.5, 0.8, 0.5],
                        } : {
                            scale: [1, 1.1, 1],
                            opacity: [0.3, 0.5, 0.3],
                        }}
                        transition={{
                            duration: isListening ? 1 : 2,
                            repeat: Infinity,
                            ease: "easeInOut",
                        }}
                    />

                    {/* Inner circle */}
                    <div className={`relative w-16 h-16 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 ${isListening
                        ? 'bg-gradient-to-br from-cyan-600 to-blue-700 border-2 border-cyan-400 shadow-cyan-500/50'
                        : isProcessing
                            ? 'bg-gradient-to-br from-amber-600 to-orange-700 border-2 border-amber-400'
                            : 'bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-cyan-500/40 shadow-cyan-500/30'
                        }`}>
                        {isProcessing ? (
                            <Loader2 className="w-7 h-7 text-white animate-spin" />
                        ) : isListening ? (
                            <MicOff className="w-7 h-7 text-white" strokeWidth={2} />
                        ) : (
                            <Mic className="w-7 h-7 text-cyan-400" strokeWidth={2} />
                        )}
                    </div>

                    {/* Pulse ring when listening */}
                    {isListening && (
                        <motion.div
                            className="absolute inset-0 rounded-full border-2 border-cyan-400/50"
                            animate={{
                                scale: [1, 1.4, 1],
                                opacity: [0.6, 0, 0.6],
                            }}
                            transition={{
                                duration: 1.5,
                                repeat: Infinity,
                                ease: "easeOut",
                            }}
                        />
                    )}
                </button>

                {/* Right Waves - Only show when listening */}
                <div className="flex items-center gap-1.5">
                    {rightWaves.map((wave, index) => (
                        <motion.div
                            key={`right-${index}`}
                            className="w-1 bg-gradient-to-t from-blue-500 to-blue-300 rounded-full"
                            animate={isListening ? {
                                height: [wave.height * 0.3, wave.height * 0.7, wave.height * 0.3],
                            } : { height: 20 }}
                            transition={{
                                duration: wave.duration,
                                repeat: Infinity,
                                delay: wave.delay,
                                ease: "easeInOut",
                            }}
                            style={{
                                transformOrigin: "center",
                                opacity: isListening ? 1 : 0.3,
                            }}
                        />
                    ))}
                </div>
            </div>

            {/* Status Text */}
            <div className="text-xs font-mono text-center">
                {isProcessing ? (
                    <span className="text-amber-400">Processing...</span>
                ) : isListening ? (
                    <span className="text-cyan-400">Listening... Tap to stop</span>
                ) : (
                    <span className="text-zinc-500">Tap to speak</span>
                )}
            </div>
        </div>
    );
}
