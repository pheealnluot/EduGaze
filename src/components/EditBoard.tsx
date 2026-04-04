import { AppData } from '../App';

type Props = {
  data: AppData;
  setData: (data: AppData) => void;
};

export default function EditBoard({ data, setData }: Props) {
  return (
    <div className="w-full max-w-2xl bg-slate-800 p-8 rounded-2xl shadow-xl border border-slate-700/50">
      <h2 className="text-2xl font-bold mb-6 text-slate-100 border-b border-slate-700 pb-4">
        Edit Configuration
      </h2>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-2">
            Question
          </label>
          <input
            type="text"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 transition-all font-medium"
            value={data.question}
            onChange={(e) => setData({ ...data, question: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {data.answers.map((answer, index) => (
            <div key={answer.id}>
              <label className="block text-sm font-medium text-slate-400 mb-2">
                Answer {index + 1}
              </label>
              <input
                type="text"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 transition-all"
                value={answer.text}
                onChange={(e) => {
                  const newAnswers = [...data.answers];
                  newAnswers[index].text = e.target.value;
                  setData({ ...data, answers: newAnswers });
                }}
              />
            </div>
          ))}
        </div>

        <div className="pt-4 border-t border-slate-700/50">
          <label className="block text-sm font-medium text-slate-400 mb-2">
            Dwell Time to Select (milliseconds)
          </label>
          <input
            type="number"
            min="500"
            step="100"
            className="w-full sm:w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 transition-all"
            value={data.dwellTimeMs}
            onChange={(e) =>
              setData({ ...data, dwellTimeMs: Number(e.target.value) })
            }
          />
          <p className="text-sm text-slate-500 mt-2">
            Duration the mouse needs to hover over an answer before it gets selected.
          </p>
        </div>
      </div>
    </div>
  );
}
