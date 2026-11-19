import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/**
 * Renders Markdown to HTML. The output is bound with [innerHTML], so Angular's
 * built-in sanitizer strips scripts and event handlers from admin-written content.
 */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return value ? (marked.parse(value, { async: false }) as string) : '';
  }
}
