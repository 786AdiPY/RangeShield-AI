import React from 'react';
import { Bot, Sparkles, ChevronRight } from 'lucide-react';

interface CoPilotCardProps {
    suggestion: string;
    onClick: () => void;
}

export default function CoPilotCard({ suggestion, onClick }: CoPilotCardProps) {
    if (!suggestion) return null;

    return (
        <div
            onClick={onClick}
            className="w-full mt-4 group cursor-pointer"
        >
            <div className="relative overflow-hidden rounded-xl border border-emerald-500/30 bg-gradient-to-br from-zinc-900 via-zinc-900 to-emerald-950/20 p-4 shadow-lg hover:border-emerald-500/50 hover:shadow-emerald-900/20 transition-all duration-300">
                {/* Decoration */}
                <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Bot className="w-24 h-24 text-emerald-500" />
                </div>

                <div className="flex items-start gap-4 relative z-10">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/30 shrink-0 group-hover:scale-110 transition-transform duration-300">
                        <Sparkles className="w-5 h-5 text-emerald-400" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <h4 className="text-sm font-bold text-emerald-400 uppercase tracking-wider font-mono">Co-Pilot Suggestion</h4>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/20">NEW</span>
                        </div>
                        <p className="text-sm text-zinc-300 leading-relaxed font-medium line-clamp-2">
                            {suggestion}
                        </p>
                    </div>

                    <div className="self-center">
                        <ChevronRight className="w-5 h-5 text-zinc-500 group-hover:text-emerald-400 group-hover:translate-x-1 transition-all" />
                    </div>
                </div>
            </div>
        </div>
    );
}
