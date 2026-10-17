# void native_run(St *in /*rdi*/, St *out /*rsi*/, void *code /*rdx*/)
# St = { u64 rax, rcx, rdx, rbx, rbp, rsi, rdi, flags }
.text
.globl native_run
native_run:
    pushq %rbx
    pushq %rbp
    pushq %r12
    pushq %r13
    movq %rsi, %r12
    movq %rdx, %r13
    pushq 56(%rdi)
    popfq
    movq 0(%rdi), %rax
    movq 8(%rdi), %rcx
    movq 16(%rdi), %rdx
    movq 24(%rdi), %rbx
    movq 32(%rdi), %rbp
    movq 40(%rdi), %rsi
    movq 48(%rdi), %rdi
    call *%r13
    pushfq
    popq 56(%r12)
    cld
    movq %rax, 0(%r12)
    movq %rcx, 8(%r12)
    movq %rdx, 16(%r12)
    movq %rbx, 24(%r12)
    movq %rbp, 32(%r12)
    movq %rsi, 40(%r12)
    movq %rdi, 48(%r12)
    popq %r13
    popq %r12
    popq %rbp
    popq %rbx
    ret
.section .note.GNU-stack,"",@progbits
