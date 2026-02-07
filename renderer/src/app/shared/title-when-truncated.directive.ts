import { AfterViewInit, Directive, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';

/** Sets the element's title to the given text only when the content is truncated (overflow). */
@Directive({ selector: '[appTitleWhenTruncated]', standalone: true })
export class TitleWhenTruncatedDirective implements AfterViewInit, OnChanges, OnDestroy {
  @Input() appTitleWhenTruncated: string = '';
  private resizeObserver: ResizeObserver | null = null;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    this.updateTitle();
    this.resizeObserver = new ResizeObserver(() => this.updateTitle());
    this.resizeObserver.observe(this.el.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['appTitleWhenTruncated']) this.updateTitle();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  private updateTitle(): void {
    const el = this.el.nativeElement;
    const text = this.appTitleWhenTruncated ?? '';
    if (!text) {
      el.removeAttribute('title');
      return;
    }
    const truncated = el.scrollWidth > el.clientWidth;
    el.title = truncated ? text : '';
  }
}
