import type { GenericAgentRuntimeParams } from '../types';
import type { NativeToolLoopState } from './tool-loop-state';

export interface NativeProcessTextStepStream {
  text: string;
}

export class NativeProcessTextStream {
  private processText = '';
  private readonly options: {
    state: NativeToolLoopState;
    onTextDelta?: GenericAgentRuntimeParams['onTextDelta'];
  };

  constructor(options: {
    state: NativeToolLoopState;
    onTextDelta?: GenericAgentRuntimeParams['onTextDelta'];
  }) {
    this.options = options;
  }

  createStepStream(): NativeProcessTextStepStream {
    return {
      text: ''
    };
  }

  emit(text: string): void {
    if (!text.trim()) {
      return;
    }
    this.processText += text;
    this.options.state.streamedText = true;
    this.options.onTextDelta?.(text, this.processText);
  }

  emitRealtimeDelta(delta: string, accumulated: string, stepStream: NativeProcessTextStepStream): void {
    stepStream.text = accumulated || `${stepStream.text}${delta}`;
    this.options.state.streamedText = true;
    this.options.onTextDelta?.(delta, `${this.processText}${stepStream.text}`);
  }

  commit(text: string, stepStream: NativeProcessTextStepStream): void {
    const nextText = text.trim() ? text : '';
    const streamedTarget = `${this.processText}${stepStream.text}`;
    const committedTarget = `${this.processText}${nextText}`;
    if (stepStream.text) {
      if (streamedTarget !== committedTarget) {
        this.options.state.streamedText = true;
        this.options.onTextDelta?.('', committedTarget);
      }
      this.processText = committedTarget;
      stepStream.text = '';
      return;
    }
    this.emit(nextText);
  }

  discard(stepStream: NativeProcessTextStepStream): void {
    if (!stepStream.text) {
      return;
    }
    this.options.state.streamedText = true;
    this.options.onTextDelta?.('', this.processText);
    stepStream.text = '';
  }
}
