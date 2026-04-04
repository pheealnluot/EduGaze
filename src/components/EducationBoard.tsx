import { useState } from 'react';
import { AppData } from '../App';
import AnswerBox from './AnswerBox';

type Props = {
  data: AppData;
};

export default function EducationBoard({ data }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleSelect = (id: string) => {
    setSelectedId(id);
  };

  return (
    <div className="w-full flex flex-col items-center gap-16">
      <h2 className="text-4xl md:text-5xl font-extrabold text-center text-slate-100 tracking-tight leading-tight">
        {data.question}
      </h2>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 w-full max-w-2xl">
        {data.answers.map((answer) => (
          <AnswerBox
            key={answer.id}
            answer={answer}
            dwellTimeMs={data.dwellTimeMs}
            isSelected={selectedId === answer.id}
            onSelect={() => handleSelect(answer.id)}
          />
        ))}
      </div>
    </div>
  );
}
