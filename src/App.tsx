import { useState } from 'react';
import EducationBoard from './components/EducationBoard';
import EditBoard from './components/EditBoard';
import { Pencil, GraduationCap } from 'lucide-react';

export type Answer = {
  id: string;
  text: string;
};

export type AppData = {
  question: string;
  answers: Answer[];
  dwellTimeMs: number;
};

const initialData: AppData = {
  question: 'What is the capital of France?',
  answers: [
    { id: '1', text: 'London' },
    { id: '2', text: 'Berlin' },
    { id: '3', text: 'Paris' },
    { id: '4', text: 'Madrid' },
  ],
  dwellTimeMs: 2000,
};

function App() {
  const [mode, setMode] = useState<'education' | 'edit'>('education');
  const [data, setData] = useState<AppData>(initialData);

  return (
    <div className="min-h-screen flex flex-col items-center py-10 px-4">
      <header className="w-full max-w-4xl flex justify-between items-center mb-10">
        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">
          EduApp
        </h1>
        <div className="flex gap-4">
          <button
            onClick={() => setMode('education')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
              mode === 'education'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <GraduationCap size={20} />
            Education Mode
          </button>
          <button
            onClick={() => setMode('edit')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
              mode === 'edit'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <Pencil size={20} />
            Edit Mode
          </button>
        </div>
      </header>

      <main className="w-full max-w-4xl flex-1 flex flex-col items-center justify-center">
        {mode === 'education' ? (
          <EducationBoard data={data} />
        ) : (
          <EditBoard data={data} setData={setData} />
        )}
      </main>
    </div>
  );
}

export default App;
