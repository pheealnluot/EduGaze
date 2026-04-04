import { useRef, useState, useEffect } from 'react';
import { Answer } from '../App';

type Props = {
  answer: Answer;
  dwellTimeMs: number;
  isSelected: boolean;
  onSelect: () => void;
};

export default function AnswerBox({ answer, dwellTimeMs, isSelected, onSelect }: Props) {
  const [isHovering, setIsHovering] = useState(false);
  const [progress, setProgress] = useState(0);
  const requestRef = useRef<number>();
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (isHovering && !isSelected) {
      const animate = (time: number) => {
        if (startTimeRef.current === null) {
          startTimeRef.current = time;
        }
        const elapsed = time - startTimeRef.current;
        const newProgress = Math.min((elapsed / dwellTimeMs) * 100, 100);
        setProgress(newProgress);

        if (newProgress >= 100) {
          onSelect();
          setIsHovering(false); // Stop progress
        } else {
          requestRef.current = requestAnimationFrame(animate);
        }
      };
      // Start the animation
      requestRef.current = requestAnimationFrame(animate);
    } else {
      // Reset
      setProgress(0);
      startTimeRef.current = null;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isHovering, dwellTimeMs, isSelected, onSelect]);

  return (
    <div
      className={`relative overflow-hidden rounded-2xl p-6 h-56 flex items-center justify-center cursor-pointer transition-all duration-300 transform outline outline-2 outline-offset-4 ${
        isSelected
          ? 'bg-blue-600 outline-blue-400 scale-[1.02] shadow-2xl shadow-blue-500/50'
          : 'bg-slate-800 outline-transparent hover:bg-slate-700 hover:shadow-xl'
      }`}
      onMouseEnter={() => !isSelected && setIsHovering(true)}
      onMouseLeave={() => !isSelected && setIsHovering(false)}
    >
      <span className={`text-2xl font-semibold text-center z-10 transition-colors ${isSelected ? 'text-white' : 'text-slate-200'}`}>
        {answer.text}
      </span>

      {/* Progress Background Indicator */}
      {!isSelected && (
        <div 
          className="absolute bottom-0 left-0 h-1.5 bg-blue-500/30 transition-none z-10"
          style={{ width: `${progress}%` }}
        />
      )}

      {/* Circular Progress Overlay */}
      {isHovering && !isSelected && progress > 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm z-20">
          <svg className="w-28 h-28 transform -rotate-90">
            <circle
              cx="56"
              cy="56"
              r="40"
              className="text-slate-700/80"
              strokeWidth="8"
              stroke="currentColor"
              fill="transparent"
            />
            <circle
              cx="56"
              cy="56"
              r="40"
              className="text-emerald-400 drop-shadow-md transition-all ease-linear"
              strokeWidth="8"
              strokeDasharray={40 * 2 * Math.PI}
              strokeDashoffset={40 * 2 * Math.PI - (progress / 100) * 40 * 2 * Math.PI}
              strokeLinecap="round"
              stroke="currentColor"
              fill="transparent"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
