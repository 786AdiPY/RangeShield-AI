import { motion } from "framer-motion";
import { Mic } from "lucide-react";

function App() {
  return (
    <div className="w-screen min-h-screen flex justify-center items-center bg-slate-950">
      <MicrophoneWithWaves />
    </div>
  );
}

function MicrophoneWithWaves() {
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
    <div className="flex items-center gap-8">
      {/* Left Waves */}
      <div className="flex items-center gap-2">
        {leftWaves.map((wave, index) => (
          <motion.div
            key={`left-${index}`}
            className="w-1.5 bg-gradient-to-t from-cyan-500 to-cyan-300 rounded-full"
            animate={{
              height: [wave.height * 0.5, wave.height, wave.height * 0.5],
            }}
            transition={{
              duration: wave.duration,
              repeat: Infinity,
              delay: wave.delay,
              ease: "easeInOut",
            }}
            style={{
              transformOrigin: "center",
            }}
          />
        ))}
      </div>

      {/* Microphone Icon */}
      <div className="relative">
        {/* Outer glow circle */}
        <motion.div
          className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 blur-xl"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.5, 0.8, 0.5],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        
        {/* Inner circle */}
        <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-cyan-500/40 flex items-center justify-center shadow-2xl shadow-cyan-500/30">
          <Mic className="w-10 h-10 text-cyan-400" strokeWidth={2} />
        </div>

        {/* Subtle pulse ring */}
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-cyan-400/50"
          animate={{
            scale: [1, 1.15, 1],
            opacity: [0.5, 0, 0.5],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      </div>

      {/* Right Waves */}
      <div className="flex items-center gap-2">
        {rightWaves.map((wave, index) => (
          <motion.div
            key={`right-${index}`}
            className="w-1.5 bg-gradient-to-t from-blue-500 to-blue-300 rounded-full"
            animate={{
              height: [wave.height * 0.5, wave.height, wave.height * 0.5],
            }}
            transition={{
              duration: wave.duration,
              repeat: Infinity,
              delay: wave.delay,
              ease: "easeInOut",
            }}
            style={{
              transformOrigin: "center",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default App;
